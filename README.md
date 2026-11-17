# Ziron

Personal assistant on Telegram: chat agent with reminders, photo understanding, university mail triage and daily briefs, backed by OpenRouter.

**Full documentation: [`docs/SYSTEM_OVERVIEW.md`](docs/SYSTEM_OVERVIEW.md)** — architecture, flows, data model, time model, config, operations, verification recipes.

## Features

- **Chat agent** (Telegram, grammY) with tools: reminders, weather, email search
- **Photos**: send a photo, an image file or an album (caption = question); the chat model reads it (vision) and can act on it, e.g. create a reminder from a photographed exam schedule
- **Reminders**: one-shot / interval / recurring, Done & Snooze buttons, DST-safe (UTC storage)
- **University mail**: IMAP IDLE push → LLM classification → instant alert with "show full mail" and "remind me before the deadline" buttons
- **Daily brief**: 07:00 (today) and 21:00 (tomorrow) study/work/admin summary from mail + scheduler, `/brief [today|tomorrow]`
- **Memory** (compact, rewritten fact lists) and **history compaction** (~8k-token threshold)
- **Service watcher** for PM2 / Docker (alerts on state change)
- OpenRouter with private routing (`data_collection: deny`), cheapest upstream first so the prompt cache hits; default model DeepSeek V4.1 Flash (`deepseek/deepseek-v4.1-flash-1017`, accepts images)
- Mail classifier eval: `node src/scripts/eval-classifier.mjs` (268 labelled mails; run before changing prompt, model or routing)

## Quick Start

```bash
npm install
cp config.json.example config.json   # fill in keys (see Configuration)
node ziron.mjs onboarding            # validate credentials
npm test                             # regression suite (~1 s)
node ziron.mjs telegram connect      # run in the foreground
```

In production the bot runs under PM2 (`pm2 restart ziron`, `pm2 logs ziron`); see `docs/SYSTEM_OVERVIEW.md` §10.

Credentials:
- **OpenRouter API key**: [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys)
- **Telegram bot token**: message [@BotFather](https://t.me/botfather), `/newbot`

## CLI

```bash
ziron onboarding                 # validate configuration & generate config.json
ziron test-openrouter            # test the OpenRouter connection
ziron config show                # show configuration (secrets masked)
ziron config get <key>
ziron config set <key> <value>   # e.g. providers.openrouter.model
ziron telegram connect           # start the bot (keeps running)
ziron telegram status            # check the bot token
ziron telegram test              # test the full integration
```

`ziron auth openai-oauth` also exists but uses an unofficial ChatGPT backend and is not used.

## Bot Commands

`/start /help /newsession /ping /model /tasks /task_today /check_be /be_snapshot /brief [today|tomorrow]`

Any other text message or photo goes to the chat agent.

## Configuration

Sources, later ones win:
1. Built-in defaults (`src/config/schema.js`)
2. `config.json` (gitignored; template `config.json.example`)
3. Environment variables `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN` (also read from `.env`)

Main keys: `providers.openrouter.{apiKey, model, maxTokens}`, `telegram.{botToken, chatId, allowedUserIds, apiRoot}`,
`database.mongoUri`, `user.{timezone, location, name}`, `tools.email.*`, `tools.weather.googleApiKey`, `dailyBrief.*`.
Full table: `docs/SYSTEM_OVERVIEW.md` §9.

Notes:
- `maxTokens` ≥ 2000 for reasoning models (they spend tokens on thinking).
- The chat model must accept image input for photos to work; text-only models (e.g. `qwen/qwen3-235b-a22b-2507`) return an error.
- `config.json` is read at startup only → restart after edits.

## Layout

```
ziron.mjs                  # CLI entrypoint
src/
├── cli/                   # CLI commands; cli/telegram.js wires the running bot
├── gateway.js             # chat turn: prompt, tools, OpenRouter adapter
├── api/client.js          # tool-calling loop + history compaction
├── storage/history.js     # JSONL sessions, photo storage, API message building
├── channels/telegram/     # grammY client, buttons, photo input (media.js)
├── scheduler/             # SQLite jobs, daily sync, 3 s poller
├── tools/                 # tool schemas + providers (email, weather)
├── services/              # daily brief, PM2/Docker watcher
├── memory/                # memory extraction
├── prompts/system.js      # system prompt
├── providers/             # low-level OpenRouter call
└── config/                # config loading
test/                      # npm test (node:test)
```

## Tech Stack

Node.js ≥ 20 (ESM), grammY, OpenRouter, better-sqlite3, MongoDB (Mongoose), imapflow, Commander.js, PM2.

## Troubleshooting

- **Bot not responding**: `pm2 logs ziron`; check the token, the OpenRouter key/credits and `telegram.allowedUserIds`.
- **Photo errors**: the configured model must support images; files over 10 MB are refused.
- **OpenRouter errors**: verify the key at [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) and the account balance.

## License

MIT. Started as a minimal rewrite inspired by [OpenClaw](https://github.com/openclaw/openclaw).
