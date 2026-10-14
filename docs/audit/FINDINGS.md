# Audit Findings: Documentation vs. Code

**HEAD**: `0b81d8e1e183698ef0defc25b5473e0f20071b78`  
**Audit date**: 2026-07-27  
**Scope**: `README.md`, `docs/SYSTEM_OVERVIEW.md` vs. every `.js` / `.mjs` source file read in full.  
**Method**: File-by-file read; grep cross-checks; no inference from names.

Legend: **WRONG** = doc states X, code proves not-X. **STALE** = was plausibly true, drifted.  
**UNVERIFIED** = code cannot confirm the claim. **VERIFIED** = code confirms the claim exactly.

---

## 1. README.md Claims

| # | Claim | Status | Evidence | Reality |
|---|-------|--------|----------|---------|
| R1 | "~1,300 LOC" | **WRONG** | `wc -l src/**/*.js src/**/**/*.js ziron.mjs` → 9,512 LOC across JS/MJS files | 9,512 lines; README reflects an early prototype state |
| R2 | Bot commands listed: `/start`, `/help`, `/ping` only | **WRONG** | `src/channels/telegram/client.js:64–131` | 9 commands registered: `/start`, `/help`, `/newsession`, `/ping`, `/model`, `/tasks`, `/task_today`, `/check_be`, `/be_snapshot` |
| R3 | Config load order: "config.json → .env → env vars" | **WRONG** | `src/config/index.js:20,40–60` | `.env` is loaded first into `process.env` (line 20), then `config.json` is read and merged with schema defaults (line 40), then explicit env vars (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`) **override both** (lines 51–60). README order is inverted. |
| R4 | "Local-first, no data sent to third-party services beyond OpenRouter" | **WRONG** | `src/tools/providers/email/classifier.js:56–80` | Email subject, sender, and 300-char snippet are sent to OpenRouter for every imported email. This is undisclosed in the README. |
| R5 | Sample config only shows `providers`, `telegram`, `database` keys | **STALE** | `src/config/schema.js:5–59` | DEFAULT_CONFIG also requires `user`, `settings`, `beWatcher`, `tools.weather`, `tools.email` sections which are entirely absent from the README's example |
| R6 | "`yaml` package: not currently used" (implied by "dotenv + JSON") | **WRONG** | `src/config/index.js:9` | `yaml` IS imported and used: `import { parse as parseYaml } from 'yaml'`; config.yaml is a supported fallback format |
| R7 | Repository name "ziron-chat" | **STALE** | `package.json:2` | Package name is `"ziron"`, not `"ziron-chat"` |
| R8 | "No tests" | **VERIFIED** | `package.json` test script: `echo "Error: no test specified" && exit 1` | Confirmed — no test files exist |
| R9 | "No CI, no Docker" | **VERIFIED** | Filesystem: no `.github/`, no `Dockerfile`, no `docker-compose.yml` | Confirmed |
| R10 | `config.json` gitignored | **VERIFIED** | `.gitignore:3` | Confirmed |

---

## 2. SYSTEM_OVERVIEW.md Claims

### 2a. Architecture & Infrastructure

| # | Claim | Status | Evidence | Reality |
|---|-------|--------|----------|---------|
| S1 | Weather provider: "Open-Meteo (free, no key)" | **WRONG** | `src/tools/providers/weather/weather.js:24` | Calls `https://weather.googleapis.com/v1/currentConditions:lookup` — Google Weather API, requires `GOOGLE_API_KEY`. Open-Meteo is not referenced anywhere in the codebase. |
| S2 | Geocoding: "Google Geocoding API" | **VERIFIED** | `src/tools/providers/weather/geocode.js:23` | Correct: `https://geocode.googleapis.com/v4/geocode/address/` |
| S3 | "No HTTP server / no ports exposed" | **WRONG** | `src/providers/openai-oauth.js:66–122` | Port **1455** is temporarily bound during the OpenAI OAuth PKCE flow. It closes after redirect, but a port is opened. |
| S4 | "Scheduler poller: 3000ms constant (line 26)" | **WRONG** (line ref) | `src/scheduler/poller.js:32` | The `setInterval(checkAndFire, 3000)` call is at **line 32**, not line 26. Line 26 is a `logger.info` statement. |
| S5 | "Two overlapping inline-button handlers can conflict" | **WRONG** | `src/cli/telegram.js:231–249`; `src/scheduler/actions.js:1–20`; `src/scheduler/callbacks.js:1–20` | The formats are **mutually exclusive by prefix**: `handleInlineAction` matches only `callback_data` starting with `!act:` (returns `true` → skips `handleCallback`). `handleCallback` handles bare `done:`, `snooze:`, `skip_today:` prefixes. No overlap is possible. |
| S6 | Only OpenRouter is active in the live gateway | **VERIFIED** | `src/gateway.js:543–549` | Explicit early-return with warning if `openrouter.apiKey` is not set: "For now, only support OpenRouter" |
| S7 | "No SIGINT/SIGTERM handling" | **VERIFIED** | grep `-rn "SIGINT\|SIGTERM" src/` → no results | Confirmed |

### 2b. Tool Counts

| # | Claim | Status | Evidence | Reality |
|---|-------|--------|----------|---------|
| S8 | "13 scheduler tools: 6 time calculators + 7 job management" | **WRONG** | `src/tools/scheduler.js:getSchedulerTools()` | **12 tools**: 6 time calculators (`calculateTime`, `calculateTimeRange`, `calculateRecurringDays`, `calculateSpecificDates`, `calculateEndTime`, `calculateNextOccurrence`) + 6 job management (`addOneshotJob`, `addOneshotInterval`, `addRecurringJob`, `listTodayJobs`, `disableJobsByName`, `listMasterJobs`). `deleteJob` is implemented in db.js but **not exposed as an LLM tool**. |
| S9 | Email tools `check_emails` and `query_emails` | **VERIFIED** | `src/tools/email.js:8–55` | Both tools defined; descriptions match |
| S10 | `getAllTools()` omits email tools | **VERIFIED** | `src/tools/index.js:13–18` | Returns only `[...getSchedulerTools(), ...getWeatherTools()]` — no email tools |

### 2c. Constants & Defaults

| # | Claim | Status | Evidence | Reality |
|---|-------|--------|----------|---------|
| S11 | `MEMORY_EXTRACTION_INTERVAL = 3` | **VERIFIED** | `src/memory/extractor.js:17` | Confirmed |
| S12 | `MAX_TOOL_LOOPS = 10` | **VERIFIED** | `src/api/client.js:60` | Confirmed |
| S13 | `max_tokens: 8192` (client-side override) | **VERIFIED** | `src/api/client.js:73` | Confirmed; this overrides schema default of 500 |
| S14 | beWatcher default 5-minute interval | **VERIFIED** | `src/config/schema.js:41` | `intervalMinutes: 5` |
| S15 | IMAP default port 993 | **VERIFIED** | `src/config/schema.js:53` | `port: 993` |
| S16 | Poller interval 3000ms | **VERIFIED** | `src/scheduler/poller.js:32` | `setInterval(checkAndFire, 3000)` |
| S17 | `providers.openrouter.maxTokens: 500` default | **VERIFIED** | `src/config/schema.js:11` | Confirmed (overridden to 8192 at runtime in client.js) |

### 2d. Storage & Persistence

| # | Claim | Status | Evidence | Reality |
|---|-------|--------|----------|---------|
| S18 | JSONL conversation history | **VERIFIED** | `src/storage/history.js:52–65` | Each message appended as one JSON line |
| S19 | Append-only memory markdown files | **VERIFIED** | `src/memory/extractor.js:270–310` | Atomic write via temp→rename, but always appending new content |
| S20 | SQLite WAL mode | **VERIFIED** | `src/scheduler/db.js:12–13` | `PRAGMA journal_mode=WAL` confirmed on both databases |
| S21 | MongoDB collections: Email, EmailState, BeSnapshot | **VERIFIED** | `src/db/models/Email.js`, `EmailState.js`, `BeSnapshot.js` | All three models confirmed |
| S22 | `truncateAndSummarize` never called automatically | **VERIFIED** | grep: no callers outside history.js itself | Confirmed — history grows without bound |

### 2e. Dead Code

| # | Claim | Status | Evidence | Reality |
|---|-------|--------|----------|---------|
| S23 | `src/scheduler/parser.js` is unreferenced | **VERIFIED** | `grep -rn "from.*parser" src/` → only mailparser references | No file imports parser.js; it is dead code |
| S24 | `src/tools/index.js` functions have no external callers | **VERIFIED** | `grep -rn "getAllTools\|getToolsByCategory" src/` → no hits outside tools/index.js itself | Both exports are dead at runtime; gateway assembles tools inline |

### 2f. Security & Credentials

| # | Claim | Status | Evidence | Reality |
|---|-------|--------|----------|---------|
| S25 | `config.json` gitignored | **VERIFIED** | `.gitignore:3` | Confirmed |
| S26 | Memory directories created with mode 0o700 | **VERIFIED** | `src/memory/extractor.js:247` | `await fs.mkdir(memoryDir, { recursive: true, mode: 0o700 })` |
| S27 | No Telegram user allowlist / any user can reach bot | **UNVERIFIED as claimed** | `src/channels/telegram/client.js:1–217`; `src/gateway.js:1–883` | The doc does not claim an allowlist exists. Code confirms: **no chat ID check anywhere**. Any user who knows the bot token can send messages and access owner's LLM credits, memory, and email data. |

### 2g. System Prompt

| # | Claim | Status | Evidence | Reality |
|---|-------|--------|----------|---------|
| S28 | 9 system prompt sections | **VERIFIED** | `src/prompts/system.js:18–697` | Identity, Behavior, Tone, Tools, Output, Scheduler, Weather, Environment, Memory |
| S29 | System prompt instructs MarkdownV2 output | **VERIFIED** | `src/prompts/system.js:113` | "Use Telegram MarkdownV2 formatting" |
| S30 | Bot sends with `parse_mode: 'Markdown'` (not MarkdownV2) | **VERIFIED** | `src/cli/telegram.js:97` | `parse_mode: 'Markdown'` — contradicts S29; mismatch causes potential Telegram 400 errors |

### 2h. Dependencies

| # | Claim | Status | Evidence | Reality |
|---|-------|--------|----------|---------|
| S31 | `@anthropic-ai/sdk` is a listed dependency | **VERIFIED** | `package.json:dependencies` | Present in package.json |
| S32 | `@anthropic-ai/sdk` is never imported in source | **VERIFIED** | `grep -rn "@anthropic" src/` → no results | Dead dependency — installed but completely unused |
| S33 | `settings.logLevel` config field | **VERIFIED (defined)** | `src/config/schema.js:33` | Field exists in DEFAULT_CONFIG |
| S34 | `settings.logLevel` is consumed by logger | **WRONG** | `src/utils/logger.js:12` | Logger reads only `process.env.LOG_LEVEL`; the config field `settings.logLevel` is **never read** and has no effect |

### 2i. Missing from Documentation

| # | Item | Evidence | Impact |
|---|------|----------|--------|
| M1 | `config.json.example` has `tools.email.notifyChatId` field absent from schema.js DEFAULT_CONFIG | `config.json.example:tools.email`, `src/config/schema.js:43–57` | Users who set this field get no effect; the field is silently ignored |
| M2 | CLI `test` sub-command and `test-openrouter` command are broken | `src/cli/telegram.js:299,318`; `src/cli/test-openrouter.js:15` | Wrong config path (`config.openrouter.apiKey` vs `config.providers.openrouter.apiKey`) + `ReferenceError: chat is not defined`; both commands crash immediately |
| M3 | Every LLM call writes full payload JSON to `~/.ziron/prompts/` | `src/gateway.js:315–329` | Indefinite file growth; contains full conversation history + system prompt |
| M4 | Email content sent to OpenRouter for classification | `src/tools/providers/email/classifier.js:56–80` | Not disclosed in any docs; privacy implication |
| M5 | Weather language hardcoded to Vietnamese ("vi") | `src/tools/providers/weather/weather.js:32` | Bot can only return weather in Vietnamese regardless of user locale |
| M6 | `user.name: 'Hiro'` hardcoded in DEFAULT_CONFIG | `src/config/schema.js:38` | Default user name leaks personal data into repo |
| M7 | `src/scripts/imap.js:8` hardcodes `unimail.tu-dortmund.de` | `src/scripts/imap.js:8` | Personal university IMAP host committed to source |
| M8 | `src/memory/extractor.js:130` hardcodes `"Hiro:"` as conversation label | `src/memory/extractor.js:130` | Memory extraction always attributes messages to "Hiro" regardless of configured user name |
