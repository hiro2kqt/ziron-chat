# System Overview — Verified

**HEAD**: `0b81d8e1e183698ef0defc25b5473e0f20071b78`  
**Audit date**: 2026-07-27  
**Method**: Every source file read in full; all claims verified against code, not inference.  
**Notation**: `[file:line]` = direct code evidence. `[CONTRADICTED]` = original doc was wrong. `[UNVERIFIED]` = code does not confirm the claim.

---

## 1. What It Is

A personal Telegram chatbot for a single owner. It wraps an LLM (OpenRouter only — `[src/gateway.js:543–549]`) with tools for task scheduling, weather lookup, and email monitoring. The bot is a long-polling Grammy client; there is no web server in the normal path. A port (1455) is bound temporarily during the OpenAI OAuth flow only `[src/providers/openai-oauth.js:66–122]`.

The package name is `"ziron"` `[package.json:2]`. Entry point: `ziron.mjs` → `src/index.js` → `initializeGateway()` + CLI program.

**`[CONTRADICTED]`** The original doc claimed "~1,300 LOC". Actual line count across all JS/MJS source files: **9,512 lines** across 51 files (measured at HEAD).

---

## 2. Repository Layout

```
ziron-chat/
├── ziron.mjs                  # Entry point; Node ≥20 guard [ziron.mjs:1–10]
├── src/
│   ├── index.js               # Calls initializeGateway then CLI parse [src/index.js:1–19]
│   ├── gateway.js             # Core LLM gateway, session management [883 lines]
│   ├── api/
│   │   └── client.js          # OpenRouter HTTP client, tool loop [190 lines]
│   ├── channels/
│   │   └── telegram/
│   │       ├── client.js      # Grammy bot, 9 commands [217 lines]
│   │       └── actions.js     # !act: callback handler [159 lines]
│   ├── cli/
│   │   ├── index.js           # Commander root [150 lines]
│   │   ├── telegram.js        # ziron telegram connect/test [333 lines] ⚠ bugs
│   │   ├── auth.js            # OpenAI OAuth CLI [101 lines]
│   │   ├── config.js          # Config show/get/set [112 lines]
│   │   ├── onboarding.js      # Interactive setup [122 lines]
│   │   └── test-openrouter.js # Test CLI [41 lines] ⚠ broken
│   ├── config/
│   │   ├── index.js           # Config loader [191 lines]
│   │   └── schema.js          # DEFAULT_CONFIG + validation [151 lines]
│   ├── db/
│   │   ├── mongo.js           # Singleton Mongoose connection [81 lines]
│   │   └── models/
│   │       ├── Email.js       # Email document schema [60 lines]
│   │       ├── EmailState.js  # Per-mailbox UID cursor [30 lines]
│   │       └── BeSnapshot.js  # Singleton BE status snapshot [33 lines]
│   ├── memory/
│   │   └── extractor.js       # Memory extraction, file I/O [352 lines]
│   ├── prompts/
│   │   └── system.js          # System prompt builder, 9 sections [697 lines]
│   ├── providers/
│   │   ├── openrouter.js      # Standalone chat/complete helpers [121 lines]
│   │   ├── openai.js          # Standalone (unused in live bot) [109 lines]
│   │   ├── openai-codex.js    # Unofficial endpoint (unused in live bot) [131 lines]
│   │   ├── openai-oauth.js    # PKCE OAuth flow, binds port 1455 [282 lines]
│   │   └── index.js           # Re-exports [7 lines]
│   ├── scheduler/
│   │   ├── db.js              # SQLite schema + CRUD [618 lines]
│   │   ├── index.js           # Public scheduler API [257 lines]
│   │   ├── poller.js          # 3000ms tick, fires jobs [171 lines]
│   │   ├── sync.js            # Daily midnight re-sync [269 lines]
│   │   ├── callbacks.js       # Legacy button handler (bare prefix) [162 lines]
│   │   └── parser.js          # ⚠ DEAD CODE — no imports anywhere
│   ├── services/
│   │   └── beWatcher.js       # PM2 + Docker status watcher [248 lines]
│   ├── storage/
│   │   └── history.js         # JSONL conversation history [393 lines]
│   ├── tools/
│   │   ├── index.js           # ⚠ DEAD CODE — getAllTools() has no callers
│   │   ├── scheduler.js       # 12 scheduler tools [898 lines]
│   │   ├── email.js           # check_emails, query_emails schemas [59 lines]
│   │   ├── weather.js         # getWeatherTools() [50 lines]
│   │   └── providers/
│   │       ├── email/
│   │       │   ├── classifier.js  # Email → OpenRouter classification [122 lines]
│   │       │   ├── monitor.js     # IMAP fetch + save [318 lines]
│   │       │   └── query.js       # MongoDB email query [155 lines]
│   │       └── weather/
│   │           ├── index.js   # Weather tool handler [164 lines]
│   │           ├── geocode.js # Google Geocoding API v4 [56 lines]
│   │           └── weather.js # Google Weather API [59 lines]
│   └── utils/
│       ├── logger.js          # Custom logger, LOG_LEVEL env var [54 lines]
│       └── time.js            # Date/time helpers [107 lines]
└── scripts/
    ├── imap.js                # Standalone IMAP test [75 lines] ⚠ personal IMAP host
    └── check-email-uid.js     # Debug utility [296 lines]
```

---

## 3. Request / Response Flow

```
Telegram user → Grammy long-poll → ctx.message.text
  → gateway.js: getOrCreateSession() → loads JSONL history
  → buildSystemPrompt() → reads memory files if present
  → api/client.js: OpenRouter HTTP POST
      ↳ max_tokens: 8192 [api/client.js:73]  ← overrides config default of 500
      ↳ MAX_TOOL_LOOPS = 10 [api/client.js:60]
      ↳ for each tool_call → onToolCall() in gateway.js
      ↳ sequential (for loop, not parallel)
  → final text reply → ctx.reply({ parse_mode: 'Markdown' })
      ↳ ⚠ system prompt says "MarkdownV2" [system.js:113] — MISMATCH
      ↳ fallback: plain text on Telegram 400 error [telegram.js:98–104]

Side effects per LLM call:
  • Full payload dumped to ~/.ziron/prompts/prompt_{ts}.json [gateway.js:315–329]
  • Message appended to ~/.ziron/sessions/{sessionId}.jsonl [history.js:52–65]
  • Every 3 messages: memory extraction LLM call [extractor.js:17]
```

---

## 4. Configuration

Config is loaded by `src/config/index.js`. True precedence order (lowest to highest):

1. Schema defaults (`src/config/schema.js:DEFAULT_CONFIG`)
2. `~/.ziron/config.json` (or `config.yaml` if JSON not found)
3. Environment variables: `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN` override the file values

**`[CONTRADICTED]`** The original README stated "config.json → .env → env vars" — the actual load order is: `.env` is loaded first into `process.env` [config/index.js:20], then the config file is merged [config/index.js:40], then env vars override both [config/index.js:51–60].

**`[CONTRADICTED]`** `settings.logLevel` in `config.json` has no effect. Logger reads only `process.env.LOG_LEVEL` [utils/logger.js:12]. The schema field is defined but never consumed.

```jsonc
// config.json — full schema (config.json.example is incomplete in the repo)
{
  "version": "0.1.0",
  "providers": {
    "openrouter": {
      "apiKey": "",              // required for gateway to start
      "model": "anthropic/claude-3.5-sonnet",
      "maxTokens": 500           // overridden to 8192 at runtime [api/client.js:73]
    },
    "openai": { "apiKey": "", "model": "gpt-4", "maxTokens": 500, "oauth": {...} }
  },
  "telegram": { "botToken": "" },
  "database": { "mongoUri": "" },
  "settings": { "logLevel": "info" },  // ⚠ IGNORED — use LOG_LEVEL env var
  "user": { "timezone": "", "location": "", "name": "Hiro" },  // ⚠ default name hardcoded
  "beWatcher": { "intervalMinutes": 5 },
  "tools": {
    "weather": { "googleApiKey": "" },
    "email": {
      "enabled": false,
      "pollIntervalHours": 2,
      "startDate": "",
      "imap": { "host": "", "port": 993, "user": "", "pass": "" }
      // ⚠ notifyChatId appears in config.json.example but is NOT in schema and has NO effect
    }
  }
}
```

---

## 5. LLM Gateway (`src/gateway.js`)

The gateway is the core of the bot. Key facts verified against code:

- **Only OpenRouter is active** `[gateway.js:543–549]`: if `config.providers.openrouter.apiKey` is unset, the gateway returns early with a warning. OpenAI and Codex providers exist but are not used in the live bot flow.
- **Session map** is stored in `~/.ziron/session-map.json` `[gateway.js:100]`. Written with `writeFileSync` (not atomic) — risk of corruption on kill `[gateway.js:106]`.
- **Memory extraction** triggers every `MEMORY_EXTRACTION_INTERVAL = 3` messages `[extractor.js:17]`. Counter is in-process and resets on restart `[gateway.js:51–61]`.
- **Tool assembly**: `[...getSchedulerTools(), ...getWeatherTools(), ...getEmailTools()]` inline at `[gateway.js:647–651]`. The `tools/index.js:getAllTools()` function is never called.
- **Prompt dump**: every LLM call writes `~/.ziron/prompts/prompt_{ts}.json` containing full payload `[gateway.js:315–329]`. No cleanup. **(Risk C2)**

---

## 6. Tool Inventory

### 6a. Scheduler tools — 12 total `[src/tools/scheduler.js:getSchedulerTools()]`

**`[CONTRADICTED]`** The original doc claimed 13 tools (7 job management). There are 12 (6 + 6). `deleteJob` is implemented in `db.js` but **not exposed as an LLM tool**.

| # | Tool name | Category |
|---|-----------|----------|
| 1 | `calculateTime` | Time calculator |
| 2 | `calculateTimeRange` | Time calculator |
| 3 | `calculateRecurringDays` | Time calculator |
| 4 | `calculateSpecificDates` | Time calculator |
| 5 | `calculateEndTime` | Time calculator |
| 6 | `calculateNextOccurrence` | Time calculator |
| 7 | `addOneshotJob` | Job management |
| 8 | `addOneshotInterval` | Job management |
| 9 | `addRecurringJob` | Job management |
| 10 | `listTodayJobs` | Job management |
| 11 | `disableJobsByName` | Job management |
| 12 | `listMasterJobs` | Job management |

Timezone parsing: supports `GMT+N`, `GMT-N`, `UTC` **only**. Named IANA timezones (e.g. `America/New_York`) will throw `[src/tools/scheduler.js]`.

### 6b. Weather tools — 2 total `[src/tools/weather.js:getWeatherTools()]`

| Tool | Backend |
|------|---------|
| `get_weather` (lookup + conditions) | Google Geocoding API v4 → **Google Weather API** `[weather/weather.js:24]` |

**`[CONTRADICTED]`** The original doc said "Open-Meteo (free, no key required)". The actual implementation calls `weather.googleapis.com` and requires a Google API key in `config.tools.weather.googleApiKey`. Weather descriptions are hardcoded to Vietnamese (`languageCode: 'vi'`) `[weather/weather.js:32]`.

### 6c. Email tools — 2 total `[src/tools/email.js]`

| Tool | Description |
|------|-------------|
| `check_emails` | Trigger IMAP fetch + classify cycle |
| `query_emails` | Query MongoDB email store |

Email tools are included in the live gateway tool list `[gateway.js:651]` but are **absent** from `src/tools/index.js:getAllTools()` (dead code).

**Privacy**: All fetched emails (subject, sender, 300-char snippet) are sent to OpenRouter for classification `[classifier.js:56–80]`. This is undisclosed in any documentation.

---

## 7. Scheduler Architecture

Two SQLite databases in `~/.ziron/scheduler/`:
- `jobs.db` — master recurring/oneshot job definitions
- `today.db` — today's job instances with fire times

Schemas verified from `src/scheduler/db.js`:

**`jobs` table**: `id`, `name`, `enabled`, `repeat_days` (JSON), `time_triggers` (JSON, contains message/buttons), `chat_id`, `created_at`, `updated_at`, `ref_id` (ALTER TABLE), `specific_dates` (ALTER TABLE)

**`today_jobs` table**: `id`, `job_id`, `name`, `chat_id`, `fire_at` (UTC epoch ms), `message`, `buttons` (JSON), `enabled`, `fired`, `source`, `date`, `created_at`, `ref_id` (ALTER TABLE), `action` (ALTER TABLE)

Poller: `setInterval(checkAndFire, 3000)` `[poller.js:32]`. Uses UTC throughout. On restart, jobs more than 10 seconds past their fire time are deleted (not refired) `[poller.js:85–90]`.

Midnight re-sync: recursive `setTimeout` schedules itself daily `[sync.js:230]`. Uses `~/.ziron/scheduler/sync-state.json` to prevent duplicate syncs within the same UTC day `[sync.js:50]`.

**`stopPoller()`** and **`stopSync()`** exist but are never called — no graceful shutdown `[Risk H4]`.

### Inline-button callback routing

Two handlers run sequentially; formats are **mutually exclusive** (no conflict):

```
callback_data starts with "!act:"
  → handleInlineAction() [actions.js]
  → formats: !act:done:<refId>, !act:delete:<refId>, !act:snooze:<min>:<todayJobId>
  → returns true → stops here

otherwise:
  → handleCallback() [callbacks.js]
  → formats: done:<name>, snooze:<min>:<todayJobId>, skip_today:<id>, delete:<jobId>
  → legacy format, generated by parser.js (dead code) — handles old buttons only
```

**`[CONTRADICTED]`** The original doc described these as "overlapping handlers that can conflict." They cannot conflict — the `!act:` prefix is a guard that makes the two handlers mutually exclusive.

---

## 8. Memory System `[src/memory/extractor.js]`

- Every `MEMORY_EXTRACTION_INTERVAL = 3` messages `[extractor.js:17]`, a second LLM call is made to extract facts from the recent conversation.
- Output is appended (atomically via temp→rename) to category files: `~/.ziron/memory/{user,feedback,project,reference}.md`
- Files grow without bound — no compaction, no pruning `[Risk M2]`
- `formatConversationForExtraction` hardcodes `"Hiro:"` as the user label regardless of `config.user.name` `[extractor.js:130]`
- Memory content is injected into every system prompt via `getMemorySection` if the file exists

---

## 9. Email Monitor `[src/tools/providers/email/]`

- IMAP via `imapflow` with `secure: true` (TLS) `[monitor.js:240]`
- First run: fetches all emails since `startDate` (or 7 days ago) in batches of 50 `[monitor.js:156]`
- Subsequent runs: fetches only UIDs above `lastSeenUID` stored in MongoDB `EmailState` collection
- Each email is classified by calling OpenRouter (`classifier.js`) → result stored in MongoDB `Email` collection
- Email tool handler `check_emails` sends notification for newly-seen important emails to the active chat ID

Poll interval: `config.tools.email.pollIntervalHours` default 2h `[schema.js:49]`.  
`disconnectMongo()` is never called on shutdown `[Risk H4]`.

---

## 10. BE Watcher `[src/services/beWatcher.js]`

Queries PM2 (`execFile('pm2', ['jlist'])`) and Docker (`execFile('docker', ['ps', '-a', '--format', '{{json .}}'])`) on a configurable interval `[beWatcher.js:25,47]`. Arguments are hardcoded — no command injection risk.

First tick is intentionally skipped (no useful diff without a prior baseline) `[beWatcher.js:216]`. Alerts are sent to all currently-active chat IDs via `getActiveChatIds()` `[beWatcher.js:230]`.

Baseline snapshot is stored as a single MongoDB document (`_id: 'singleton'`) `[BeSnapshot.js:8]`. Written only via `ziron be snapshot` CLI command; never overwritten by the watcher.

---

## 11. System Prompt `[src/prompts/system.js]`

9 sections assembled per request:

| # | Section | Dynamic? |
|---|---------|---------- |
| 1 | Identity | Static |
| 2 | Behavior | Static |
| 3 | Tone | Static — instructs **MarkdownV2** `[system.js:113]` ⚠ |
| 4 | Tools | Static |
| 5 | Output | Static |
| 6 | Scheduler | Static |
| 7 | Weather | Static |
| 8 | Environment | Dynamic — UTC time, timezone, location, chatId, refId (UUID per turn) |
| 9 | Memory | Dynamic — injects file contents if `~/.ziron/memory/*.md` exists |

⚠ Section 3 instructs MarkdownV2, but the reply call uses `parse_mode: 'Markdown'` `[telegram.js:97]`. See Risk H2.

---

## 12. Known Dead Code

| File | Reason | Evidence |
|------|--------|----------|
| `src/scheduler/parser.js` | No file imports it | grep: zero import hits |
| `src/tools/index.js` | `getAllTools()` has no external callers | grep: zero import hits outside file |
| `src/providers/openai.js` | Not used in live bot; `refreshOAuthToken` throws "not yet implemented" | gateway.js import check |
| `src/providers/openai-codex.js` | Not used in live bot; uses undocumented `chatgpt.com/backend-api` | gateway.js import check |

---

## 13. Known Bugs (code-confirmed)

| ID | Location | Description |
|----|----------|-------------|
| B1 | `src/cli/telegram.js:299` | `config.openrouter.apiKey` → should be `config.providers.openrouter.apiKey`; throws TypeError |
| B2 | `src/cli/telegram.js:318` | Calls bare `chat(...)` which is not in scope; throws ReferenceError |
| B3 | `src/cli/test-openrouter.js:15` | Same wrong config path as B1; command crashes immediately |
| B4 | `src/prompts/system.js:113` vs `src/cli/telegram.js:97` | System prompt says MarkdownV2; bot sends `parse_mode: 'Markdown'`; causes Telegram 400 errors on MarkdownV2-escaped text |

---

## 14. External API Dependencies

| Service | Endpoint | Key required | Notes |
|---------|----------|-------------|-------|
| OpenRouter | `openrouter.ai/api/v1/chat/completions` | Yes | Primary LLM; all gateway traffic |
| OpenRouter | same | Yes | Email classification (classifier.js) |
| Google Geocoding | `geocode.googleapis.com/v4/geocode/address` | Yes | Weather tool, lat/lon lookup |
| **Google Weather API** | `weather.googleapis.com/v1/currentConditions:lookup` | Yes | **`[CONTRADICTED]`** — doc said Open-Meteo |
| MongoDB Atlas (or self-hosted) | Mongoose connection string | Yes (URI) | Email, EmailState, BeSnapshot |
| IMAP server | Configured host:993 | Yes (imap.pass) | Email fetch; TLS enforced |
| Telegram Bot API | Long-poll | Yes (botToken) | All bot I/O |
| OpenAI OAuth | `auth.openai.com` | Implicit (PKCE) | CLI-only; not used in live bot flow |
