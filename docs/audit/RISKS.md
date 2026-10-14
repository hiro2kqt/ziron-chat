# Risk Register

**HEAD**: `0b81d8e1e183698ef0defc25b5473e0f20071b78`  
**Audit date**: 2026-07-27  
**Scope**: All source files read in full. No inference from filenames.

> **Status update (2026-10-11, uncommitted working-tree changes — see `docs/SYSTEM_OVERVIEW.md` §0):**
> - **C1 (no Telegram auth) — mitigated.** `src/channels/telegram/auth.js` + `telegram.allowedUserIds` config now gate every inbound update on `ctx.from.id` before any handler runs. Still defaults to empty/open if left unconfigured — verify `config.json` actually sets it.
> - **M6 (`tools.email.notifyChatId` ignored by schema) — superseded.** That dead field was removed from `config.json.example`; a real general-purpose `telegram.chatId` forced-routing field now exists instead (routing only, not auth).
> - All other findings below (C2, H1–H5, M1–M5, M7, L1–L6) are **unverified against current state** — re-check before relying on them.

Severity scale: **Critical** = data breach / account takeover / data loss without user action.  
**High** = crash / silent data corruption / significant privacy leak. **Medium** = degraded correctness or reliability. **Low** = maintenance burden, cosmetic, or hypothetical.

---

## Critical

### C1 — No Telegram user authorization

**What**: The bot accepts messages from any Telegram user who discovers its bot token. No chat ID allowlist, no password, no username check.

**Where**: `src/channels/telegram/client.js` (no guard), `src/gateway.js:509–600` (no chat ID validation before processing)

**Runtime behavior**: Any user can:
- Send arbitrary chat messages → billed to the owner's OpenRouter account
- Trigger `check_emails` and `query_emails` → read the owner's email metadata from MongoDB
- Trigger `addRecurringJob` → write jobs to the owner's SQLite scheduler
- Read extracted memory files that are injected into every system prompt

**Blast radius**: API credit exhaustion, private email metadata exposure, scheduler corruption, memory leakage.

**Fix**: Add a `config.telegram.allowedChatIds: []` field. In `src/channels/telegram/client.js`, on every `bot.on('message', ...)` and command handler, check `ctx.chat.id` against the allowlist; if not present, reply with an unauthorized message and return. If `allowedChatIds` is empty (default), the gateway should either block all users or log a prominent warning.

---

### C2 — Debug prompt dumps contain full sensitive payloads and grow forever

**What**: Every single LLM call writes the complete request payload — including the system prompt (which contains full memory file contents), the entire conversation history, and all tool definitions — to `~/.ziron/prompts/prompt_{timestamp}.json`. No cleanup mechanism exists.

**Where**: `src/gateway.js:314–329`

```js
// line 314
try {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const promptDir = path.join(zironDir, 'prompts');
  await fs.mkdir(promptDir, { recursive: true });
  const promptFile = path.join(promptDir, `prompt_${timestamp}.json`);
  await fs.writeFile(promptFile, JSON.stringify(fullPayload, null, 2));
  ...
```

**Runtime behavior**: A bot sending/receiving 50 messages per day with 3 tool iterations each produces ~150 files/day, each potentially several MB. After 30 days: thousands of files, gigabytes of disk. Each file contains memory snippets (which may hold passwords, tokens, personal notes injected by the user), full email summaries discussed in-chat, etc.

**Blast radius**: Disk exhaustion (OS instability). Anyone with read access to `~/.ziron/prompts/` reads full conversation history. On a shared host, this exposes everything to other processes running as the same user.

**Fix**: Remove the dump block entirely (it is labeled "debug" but is always-on). If debug logging is genuinely needed, gate it behind `LOG_LEVEL=debug` and a separate `DEBUG_PROMPTS=1` env var. Add a cron/startup cleanup that deletes files older than 24h if the feature is kept.

---

## High

### H1 — Broken CLI commands: `ziron telegram test` and `ziron test-openrouter`

**What**: Two CLI commands crash before doing any work.

**Where (bug 1)**: `src/cli/test-openrouter.js:15` and `src/cli/telegram.js:299`
```js
// Both files:
config.openrouter.apiKey   // TypeError: cannot read property 'apiKey' of undefined
// Correct path:
config.providers.openrouter.apiKey
```

**Where (bug 2)**: `src/cli/telegram.js:318`
```js
const response = await chat('Say hello in one sentence', config.openrouter.apiKey, {});
// `chat` is not imported — name does not exist in scope.
// Imports at lines 8–10 use aliases: openrouterChat, openaiChat, openaiCodexChat
```

**Runtime behavior**: Both commands throw immediately on execution — TypeError then ReferenceError. They cannot be used at all.

**Blast radius**: Regression in developer testing workflow; no live bot impact.

**Fix (bug 1)**: Replace `config.openrouter.apiKey` with `config.providers.openrouter.apiKey` at both locations.  
**Fix (bug 2)**: Replace bare `chat(...)` call with `openrouterChat(...)`.

---

### H2 — Markdown / MarkdownV2 mismatch causes Telegram 400 errors

**What**: The system prompt instructs the LLM to format output in **Telegram MarkdownV2** (uses `\.`, `\-`, `\(` escaping). The reply call uses `parse_mode: 'Markdown'` (original Markdown, which does not require escaping). Characters that MarkdownV2 requires escaped (`.`, `!`, `(`, `)`, `-`, etc.) will cause Telegram to return a 400 error.

**Where**: 
- System prompt directive: `src/prompts/system.js:113` — "Use Telegram MarkdownV2 formatting"
- Reply call: `src/cli/telegram.js:97` — `{ parse_mode: 'Markdown' }`

**Runtime behavior**: Any LLM response containing `\.` or `\-` or `\(` (MarkdownV2 escapes) in its raw text will be rejected by Telegram's Markdown parser. The code has a fallback (lines 98–104): catches the Telegram error and resends as plain text — so the user sees an unformatted dump of the raw text including all escape characters.

**Blast radius**: Degraded user experience on any structured reply (lists, code blocks, inline formatting). The fallback masks the error so it's silent.

**Fix (option A — preferred)**: Change `parse_mode: 'Markdown'` to `parse_mode: 'MarkdownV2'` in `src/cli/telegram.js:97`.  
**Fix (option B)**: Change the system prompt to instruct plain Markdown, and remove LLM-side escaping rules.

---

### H3 — Email content sent to third-party LLM without disclosure

**What**: Every email fetched by the monitor (subject, sender, 300-char snippet) is sent to OpenRouter for classification. OpenRouter is a routing layer that sends requests to multiple underlying model providers (Anthropic, Google, Meta, etc.).

**Where**: `src/tools/providers/email/classifier.js:56–80`
```js
const classification = await classifyEmail({
  subject: email.subject,
  from: email.from,
  snippet: email.snippet,
});
// classifyEmail calls openrouter.chat() at classifier.js:90
```

**Runtime behavior**: On every email poll cycle (`pollIntervalHours`, default 2h), all emails since the last seen UID are fetched and their content transmitted to OpenRouter's API endpoint. This happens even for "unimportant" emails.

**Blast radius**: Privacy — employer emails, personal communications, financial notifications leave the local machine silently. OpenRouter's data retention policy applies.

**Fix**: Document this behavior prominently in setup docs and the `tools.email` config section. Consider classifying locally (keyword rules or a local model) before falling back to a remote API.

---

### H4 — No graceful shutdown: SQLite, MongoDB, intervals left open

**What**: The process has no `SIGINT`/`SIGTERM` handlers. When killed (Ctrl-C, `pm2 stop`, OS shutdown), all resources are abandoned mid-flight.

**Where**: 
- No signal handlers: confirmed via `grep -rn "SIGINT\|SIGTERM" src/` → zero results
- `closeDatabases()` exists at `src/scheduler/db.js:610` but is never called
- `stopPoller()` exists at `src/scheduler/poller.js:155` but is never called
- `stopSync()` exists at `src/scheduler/sync.js:256` but is never called
- `disconnectMongo()` exists at `src/db/mongo.js:72` but is never called
- Grammy `bot.stop()` exists but is never invoked

**Runtime behavior**: If the process is killed while writing to SQLite (even in WAL mode), the WAL file may be left dirty. In-flight IMAP connections are dropped without `logout()`. MongoDB connections are severed without a clean close. PM2-managed restarts will produce orphaned handles.

**Blast radius**: Low probability of data corruption (WAL mode is resilient), but leaks of OS file descriptors and sockets on each restart; MongoDB replica set may log unexpected disconnections.

**Fix**: Add to `ziron.mjs` or `src/index.js`:
```js
async function shutdown() {
  bot.stop();
  stopPoller();
  stopSync();
  await closeDatabases();
  await disconnectMongo();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

---

### H5 — `saveSessionMap` is not atomic

**What**: `src/gateway.js:106` uses `writeFileSync` to overwrite `session-map.json`. If the process is killed mid-write, the file is truncated and all session routing (chat-ID → session-file mapping) is lost.

**Where**: `src/gateway.js:106`
```js
function saveSessionMap() {
  fs.writeFileSync(sessionMapFile, JSON.stringify(sessionMap, null, 2));
}
```

**Runtime behavior**: On process kill during a write → `session-map.json` is empty or partial JSON → on next start, `JSON.parse` throws → bot fails to start until the file is manually deleted.

**Blast radius**: Bot downtime; all active sessions become unreachable (new sessions are created automatically, so data is not lost, only continuity is broken).

**Fix**: Write to a temp file first, then `fs.renameSync(tmp, sessionMapFile)` (same pattern already used in `src/memory/extractor.js:270`).

---

## Medium

### M1 — History JSONL files grow without bound

**What**: `src/storage/history.js` appends every message to a per-session `.jsonl` file. `truncateAndSummarize` is implemented but has **zero callers**; it is never invoked automatically.

**Where**: `src/storage/history.js:259` (`truncateAndSummarize` defined); grep for callers → none outside the file itself.

**Runtime behavior**: A long-running session will accumulate thousands of messages. On each request, `getMessages` reads the entire file. Large files slow every request linearly.

**Blast radius**: Performance degradation on long sessions; eventually enough history to exceed model context window (though `client.js` trims to last N messages — behavior unverified from code).

**Fix**: Call `truncateAndSummarize` automatically in `appendMessage` when the file exceeds a configurable threshold (e.g., 200 messages). Alternatively, call it at session-start if file is above threshold.

---

### M2 — Memory markdown files grow without bound

**What**: `src/memory/extractor.js` appends extracted facts to `~/.ziron/memory/*.md` files every `MEMORY_EXTRACTION_INTERVAL` messages (every 3). No pruning, no deduplication.

**Where**: `src/memory/extractor.js:270–310`

**Runtime behavior**: After months of use, each memory file can grow to many thousands of lines. The entire file is injected into the system prompt at every request (via `getMemorySection`). Eventually the memory section alone can push the conversation beyond context limits.

**Blast radius**: Increased token cost per request; potential context window overflow causing API errors.

**Fix**: Implement a periodic memory compaction step that summarizes and deduplicates the memory files (another LLM call). Add a configurable max file size; when exceeded, compact before appending.

---

### M3 — `settings.logLevel` config field is silently ignored

**What**: `src/config/schema.js:33` defines `settings.logLevel: 'info'` as a configurable field. `src/utils/logger.js:12` reads only `process.env.LOG_LEVEL`. The config field is never read.

**Where**: `src/utils/logger.js:12` vs `src/config/schema.js:33`

**Runtime behavior**: Users who set `settings.logLevel: 'debug'` in `config.json` see no change in log verbosity. Only the `LOG_LEVEL` environment variable works.

**Fix**: In `src/gateway.js` or `src/index.js`, after loading config, call `process.env.LOG_LEVEL = config.settings.logLevel` (or expose a `setLogLevel` function in logger.js and call it with the config value).

---

### M4 — Message counter lost on restart; memory extraction timing unreliable

**What**: `gatewayState.messageCounters` (a `Map` at `src/gateway.js:51–61`) tracks message count per session for memory extraction trigger. It is in-process memory only.

**Where**: `src/gateway.js:51–61`

**Runtime behavior**: On every process restart, all counters reset to 0. Memory extraction will not trigger until 3 new messages are exchanged per session post-restart, regardless of how many messages existed before. For very frequent restarts (e.g., rapid deployments), memory extraction may never trigger.

**Blast radius**: Missed memory extractions; memory files may not reflect recent facts after a restart cycle.

**Fix**: Persist `messageCounters` in `session-map.json` alongside the session path, loaded on startup.

---

### M5 — Timezone support limited to `GMT±N` and `UTC` formats only

**What**: `src/tools/scheduler.js` parses timezone strings in `calculateTime`, `calculateRecurringDays`, and related tools. The parser uses a regex that only matches `GMT+N`, `GMT-N`, or `UTC`.

**Where**: `src/tools/scheduler.js` (timezone parsing logic)

**Runtime behavior**: If a user configures `user.timezone: 'America/New_York'` or `'Asia/Ho_Chi_Minh'`, any scheduler tool that calls the timezone parser will throw. The LLM passes the configured timezone string to tools — if the string is a named IANA timezone, it will fail.

**Blast radius**: Scheduler completely non-functional for users with named IANA timezones.

**Fix**: Use `Intl.DateTimeFormat` (built-in Node.js, no dependencies) instead of a custom GMT parser:
```js
const offset = -new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'shortOffset' })
  .formatToParts().find(p => p.type === 'timeZoneName').value.replace('GMT','') * 60;
```

---

### M6 — `config.json.example` exposes `tools.email.notifyChatId` field that schema ignores

**What**: `config.json.example` includes a `tools.email.notifyChatId` key. This field does not exist in `src/config/schema.js` DEFAULT_CONFIG and is not used anywhere in the codebase.

**Where**: `config.json.example` (field present); `src/config/schema.js:43–57` (field absent)

**Runtime behavior**: Users who set this field thinking it controls notification routing will see no effect. The email monitor sends notifications to all active chat IDs from `getActiveChatIds()` regardless.

**Fix**: Either implement the field (restrict email notifications to a specific chat ID when set) or remove it from the example file.

---

### M7 — Weather language hardcoded to Vietnamese

**What**: `src/tools/providers/weather/weather.js:32` passes `languageCode: 'vi'` to the Google Weather API. All weather responses are in Vietnamese regardless of the user's configured locale.

**Where**: `src/tools/providers/weather/weather.js:32`

**Runtime behavior**: Weather results always arrive in Vietnamese. The LLM then translates or paraphrases them in its reply language, but the raw data (condition descriptions, icons) may leak through in Vietnamese.

**Fix**: Read the language from config (e.g., `config.user.language`) or derive it from the user's timezone/location. Fall back to `'en'`.

---

## Low

### L1 — `src/scheduler/parser.js` is dead code

**What**: `parser.js` exports `buildRecurringJob`, `buildOneshotJob`, and `buildOneshotInterval`. No file in the codebase imports it. It also generates callback buttons in the old format (`done:<name>`) that is incompatible with the current `!act:` prefix format used by `actions.js`.

**Where**: `src/scheduler/parser.js:1–111`

**Fix**: Delete the file. If button-building logic is needed in future, rewrite against the `!act:` format.

---

### L2 — `src/tools/index.js` is dead code

**What**: `getAllTools()` and `getToolsByCategory()` are exported but never imported by any other module. The live gateway assembles its own tool list inline at `src/gateway.js:647–651`. `getAllTools()` also omits email tools, so if it were ever used it would produce an incomplete set.

**Where**: `src/tools/index.js:1–42`

**Fix**: Delete the file, or refactor `gateway.js` to import from it (and add email tools to it).

---

### L3 — `@anthropic-ai/sdk` is an unused dependency

**What**: `@anthropic-ai/sdk` appears in `package.json` dependencies but is never imported anywhere in source.

**Where**: `package.json:dependencies`

**Fix**: `yarn remove @anthropic-ai/sdk`. Reduces install size and removes a non-zero supply-chain attack surface.

---

### L4 — Hardcoded personal data in source files

Three instances of personal data hardcoded in committed source:

| Location | Value | Risk |
|----------|-------|------|
| `src/config/schema.js:38` | `user.name: 'Hiro'` | Default name leaks identity; new users inherit it silently |
| `src/memory/extractor.js:130` | `'Hiro:'` conversation label | Memory extraction always attributes messages to "Hiro" regardless of configured name |
| `src/scripts/imap.js:8` | `'unimail.tu-dortmund.de'` | University IMAP host committed; private institutional association visible in public repo |

**Fix**: Replace the hardcoded strings with `config.user.name` or a generic placeholder (`'User'`). Remove or sanitize `src/scripts/imap.js` before any public release.

---

### L5 — `yarn.lock` committed despite being gitignored

**What**: `.gitignore` lists `yarn.lock` at line 8, but the file is present in the repo tree and tracked by git.

**Where**: `.gitignore:8`; `yarn.lock` (exists)

**Runtime behavior**: `yarn install` will use the lockfile, so this is not dangerous. But it contradicts the gitignore intent and causes git to track dependency versions when it apparently should not.

**Fix**: Either remove `yarn.lock` from `.gitignore` (intentionally track it — recommended for reproducibility) or run `git rm --cached yarn.lock` and commit to stop tracking it.

---

### L6 — `src/tools/providers/weather/weather.js` has legacy "Gemini-compatible" comment

**What**: A comment at `src/tools/providers/weather/weather.js:12` reads "Gemini-compatible" — a relic from an earlier provider (Gemini API was likely the original weather caller).

**Where**: `src/tools/providers/weather/weather.js:12`

**Fix**: Remove the comment; the function calls Google Weather API now, not Gemini.
