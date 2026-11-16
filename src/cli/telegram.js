/**
 * Telegram command group
 * Start bot, status, test commands
 */

import { initDailyBrief, buildBrief } from '../services/dailyBrief.js';
import { utcTimeToLocal, formatLocal } from '../utils/time.js';
import { shiftUtcTime } from '../scheduler/sync.js';
import { loadConfig, getForcedChatId } from '../config/index.js';
import { setReplyConfig, replyTo, typingTo, replyWithPlaceholder } from '../channels/telegram/reply.js';
import { createClient, validateBotToken } from '../channels/telegram/index.js';
import { chat as openrouterChat } from '../providers/openrouter.js';
import { chat as openaiChat } from '../providers/openai.js';
import { chat as openaiCodexChat } from '../providers/openai-codex.js';
import { handleMessage, resetSession, initScheduler, addOneshotJob, initEmailMonitoring, listTodayJobs, listMasterJobs } from '../gateway.js';
import { handleCallback } from '../scheduler/callbacks.js';
import { handleInlineAction } from '../channels/telegram/actions.js';
import { createAuthMiddleware } from '../channels/telegram/auth.js';
import { startVoiceServer } from '../channels/voice/server.js';
import { checkStatus, formatStatusMessage, initBeWatcher, takeSnapshot } from '../services/beWatcher.js';
import logger from '../utils/logger.js';

export async function connectCommand() {
  logger.info('🤖 Starting Telegram bot...\n');

  const config = loadConfig();
  setReplyConfig(config);

  if (!config.telegram.botToken) {
    logger.error('Missing Telegram bot token');
    logger.info('Get a token from @BotFather on Telegram');
    logger.info('Then add to .env: TELEGRAM_BOT_TOKEN=your_token');
    process.exit(1);
  }

  // Warn when no allowlist is configured (risk C1: any user can reach the bot)
  const allowedUserIds = config.telegram.allowedUserIds ?? [];
  if (allowedUserIds.length === 0) {
    logger.warn('[Auth] telegram.allowedUserIds is empty — bot will respond to ANY Telegram user.');
    logger.warn('[Auth] Set allowedUserIds in config.json to restrict access (see docs/audit/RISKS.md#C1).');
  } else {
    logger.info(`[Auth] Allowlist active: ${allowedUserIds.length} user(s) permitted.`);
  }

  // Forced outbound destination — null means reply to the originating chat (default behavior)
  const forcedChatId = getForcedChatId(config);
  if (forcedChatId) {
    logger.info(`[Routing] Forced outbound chatId: ${forcedChatId}`);
  }

  // Check which provider is configured
  const hasOpenRouter = config.providers.openrouter.apiKey;
  const hasOpenAIKey = config.providers.openai.apiKey;
  const hasOpenAIOAuth = config.providers.openai.oauth.accessToken;

  if (!hasOpenRouter && !hasOpenAIKey && !hasOpenAIOAuth) {
    logger.warn('No AI provider configured - bot will not respond to messages');
    logger.info('Configure a provider:');
    logger.info('  - OpenRouter: Add OPENROUTER_API_KEY to .env');
    logger.info('  - OpenAI: Add OPENAI_API_KEY to .env or run: ziron auth openai-oauth\n');
  }

  // Prioritize: OpenRouter > OpenAI OAuth (Codex) > OpenAI API Key
  const provider = hasOpenRouter ? 'openrouter'
    : hasOpenAIOAuth ? 'openai-codex'
    : hasOpenAIKey ? 'openai'
    : null;

  const activeModel = provider === 'openrouter'
    ? config.providers.openrouter.model
    : provider === 'openai' || provider === 'openai-codex'
      ? config.providers.openai.model
      : null;

  if (provider) {
    logger.info(`Using provider: ${provider}`);
    if (provider === 'openai-codex') {
      logger.info(`OAuth: ${config.providers.openai.oauth.email}\n`);
    }
  }

  try {
    const client = createClient(config.telegram.botToken, config.telegram.apiRoot);

    // Register authorization middleware FIRST — before any command, message,
    // or callback handler — so no downstream work is done for unauthorized users
    client.bot.use(createAuthMiddleware(config));

    // Get bot info
    const me = await client.getMe();
    logger.success(`Logged in as: @${me.username} (${me.first_name})`);
    logger.info('Bot ID:', me.id);
    logger.info('');

    // Message handlers
    const handlers = {
      onMessage: async (ctx) => {
        const text = ctx.message.text;

        if (!provider) {
          await replyTo(ctx, '⚠️ No AI provider configured. Cannot respond.');
          return;
        }

        // "💭 thinking..." placeholder after 1.5s, edited into the answer
        try {
          await replyWithPlaceholder(ctx, async () => {
            const response = await handleMessage({
              channelType: 'telegram',
              channelId: ctx.chat.id,
              userMessage: text,
            });
            logger.info(`[Bot]: ${String(response).substring(0, 100)}...`);
            return response;
          });
        } catch (err) {
          logger.error('Gateway error:', err.message);
        }
      },

      onNewSession: async (ctx) => {
        try {
          const sessionId = resetSession('telegram', ctx.chat.id);
          logger.info(`New session created for chat ${ctx.chat.id}: ${sessionId}`);
          await replyTo(ctx, '✨ Started a new conversation! Previous messages have been cleared.');
        } catch (err) {
          logger.error('Failed to create new session:', err.message);
          await replyTo(ctx, '❌ Failed to create new session.');
        }
      },

      onModel: async (ctx) => {
        if (!activeModel) {
          await replyTo(ctx, '⚠️ No model configured.');
          return;
        }
        await replyTo(ctx, `🤖 Current model: ${activeModel}`);
      },

      onTasks: async (ctx) => {
        try {
          const jobs = await listMasterJobs(ctx.chat.id);
          if (!jobs.length) {
            await replyTo(ctx, 'No tasks configured.');
            return;
          }
          // Master times are UTC computed with tz_offset_min; that offset
          // recovers the intended local wall-clock time
          const lines = jobs.map(j => {
            const times = (j.time_triggers || [])
              .map(t => shiftUtcTime(t.time, j.tz_offset_min ?? 120).slice(0, 5))
              .join(', ') || '—';
            return `• ${j.name} [${times}]`;
          });
          await replyTo(ctx, `📋 Scheduled tasks:\n\n${lines.join('\n')}`);
        } catch (err) {
          logger.error('Failed to list tasks:', err.message);
          await replyTo(ctx, '❌ Failed to retrieve tasks.');
        }
      },

      onBrief: async (ctx) => {
        try {
          const arg = String(ctx.match || '').trim().toLowerCase();
          // Command args are English, like the commands themselves: /brief [today|tomorrow]
          const kind = /^(tomorrow|tmr)$/.test(arg) ? 'evening' : 'morning';
          // Placeholder right away (the brief takes a few seconds), edited into the result
          await replyWithPlaceholder(ctx, () => buildBrief(kind, config), {
            delayMs: 0,
            text: '⏳ Đang tổng hợp...',
            onError: '❌ Không tạo được bản tóm tắt.',
          });
        } catch (err) {
          logger.error('Brief failed:', err.message);
        }
      },

      onTaskToday: async (ctx) => {
        try {
          const jobs = await listTodayJobs(ctx.chat.id);
          if (!jobs.length) {
            await replyTo(ctx, 'No tasks for today.');
            return;
          }
          const lines = jobs.map(j => {
            const status = j.fired ? '✅' : '⏳';
            return `${status} ${j.name} @ ${utcTimeToLocal(j.fire_at, j.date)}`;
          });
          await replyTo(ctx, `📅 Today's tasks:\n\n${lines.join('\n')}`);
        } catch (err) {
          logger.error('Failed to list today tasks:', err.message);
          await replyTo(ctx, '❌ Failed to retrieve today\'s tasks.');
        }
      },

      onCheckBe: async (ctx) => {
        try {
          const result = await checkStatus(config.database?.mongoUri);
          const msg = formatStatusMessage(result);
          logger.debug('[BeWatcher] Replying with: ' + msg);
          await replyTo(ctx, msg);
        } catch (err) {
          logger.error('Failed to check BE status:', err.message);
          await replyTo(ctx, '❌ Failed to check service status.');
        }
      },

      onBeSnapshot: async (ctx) => {
        try {
          const doc = await takeSnapshot(config.database?.mongoUri);
          const ts = formatLocal(doc.createdAt);
          await replyTo(ctx,
            `📸 Snapshot saved\n\n` +
            `PM2 processes: ${doc.pm2.length}\n` +
            `Docker containers: ${doc.docker.length}\n` +
            `Saved at: ${ts}`,
          );
        } catch (err) {
          logger.error('Failed to take BE snapshot:', err.message);
          await replyTo(ctx, '❌ Failed to take snapshot.');
        }
      },
    };

    // Initialize scheduler before bot starts.
    // When forcedChatId is set, ALL outbound messages (scheduler, email, beWatcher)
    // are redirected to that destination regardless of the chatId stored in the job.
    const sendMessage = async (chatId, text, options = {}) => {
      if (!text || text.trim() === '') {
        return; // Don't send empty messages
      }
      const target = forcedChatId ?? chatId;
      const opts = { parse_mode: 'Markdown', ...options };
      try {
        await client.sendMessage(target, text, opts);
      } catch (err) {
        // Same fallback as chat replies: if Markdown can't be parsed, send the
        // text plain instead of losing the reminder / email notification
        if (opts.parse_mode && /can't parse entities/i.test(err.message || '')) {
          logger.warn('Markdown parse failed, sending plain text');
          const { parse_mode, ...plain } = opts;
          await client.sendMessage(target, text, plain);
        } else {
          throw err;
        }
      }
    };

    try {
      await initScheduler(sendMessage);
    } catch (err) {
      logger.error('Scheduler initialization failed:', err.message);
      logger.warn('Bot will continue without scheduler');
    }

    // Initialize email monitoring if enabled
    try {
      initEmailMonitoring(sendMessage);
    } catch (err) {
      logger.error('Email monitoring initialization failed:', err.message);
      logger.warn('Bot will continue without email monitoring');
    }

    // Morning (today) / evening (tomorrow) brief from email + scheduler
    try {
      initDailyBrief(sendMessage, config);
    } catch (err) {
      logger.error('Daily brief initialization failed:', err.message);
    }

    // Start BE watcher
    try {
      initBeWatcher(sendMessage, config);
    } catch (err) {
      logger.error('BE watcher initialization failed:', err.message);
      logger.warn('Bot will continue without BE watcher');
    }

    // Start voice channel server (REST chat + SSE reminders for the browser dashboard).
    // Runs in this same process so it can receive the scheduler's "job due" push above.
    if (config.voice?.enabled) {
      try {
        startVoiceServer();
      } catch (err) {
        logger.error('Voice server initialization failed:', err.message);
        logger.warn('Bot will continue without the voice channel');
      }
    } else {
      logger.info('[Voice] Disabled in config (voice.enabled = false)');
    }

    // Register callback query handler for scheduler buttons
    client.bot.on('callback_query:data', async (ctx) => {
      try {
        const handled = await handleInlineAction(ctx);
        if (handled) return;

        await handleCallback(ctx, addOneshotJob);
      } catch (err) {
        logger.error('Callback error:', err);
        await ctx.answerCallbackQuery('❌ Có lỗi xảy ra');
      }
    });

    logger.info('Starting bot... Press Ctrl+C to stop\n');
    await client.start(handlers);

  } catch (err) {
    logger.error('Failed to start bot:', err.message);
    process.exit(1);
  }
}

export async function statusCommand() {
  logger.info('📊 Telegram Bot Status\n');

  const config = loadConfig();

  if (!config.telegram.botToken) {
    logger.warn('Bot token not configured\n');
    logger.info('Get a token from @BotFather and add to .env');
    return;
  }

  logger.info('Checking bot token...');

  try {
    const me = await validateBotToken(config.telegram.botToken, config.telegram.apiRoot);

    if (me) {
      logger.success('Bot token valid!\n');
      logger.info('Bot Info:');
      logger.info(`  Username: @${me.username}`);
      logger.info(`  Name:     ${me.first_name}`);
      logger.info(`  ID:       ${me.id}`);
      logger.info(`  Can join groups: ${me.can_join_groups ? 'Yes' : 'No'}`);
      logger.info('');
      logger.info('To start the bot: ziron telegram connect');
    } else {
      logger.error('Invalid bot token');
    }

  } catch (err) {
    logger.error('Error checking status:', err.message);
  }
}

export async function testCommand() {
  logger.info('🧪 Testing Telegram + OpenRouter integration\n');

  const config = loadConfig();

  // Check configs
  if (!config.telegram.botToken) {
    logger.error('Missing Telegram bot token');
    process.exit(1);
  }

  if (!config.openrouter.apiKey) {
    logger.error('Missing OpenRouter API key');
    process.exit(1);
  }

  try {
    // Test Telegram
    logger.info('1. Testing Telegram bot token...');
    const me = await validateBotToken(config.telegram.botToken, config.telegram.apiRoot);

    if (!me) {
      logger.error('   Invalid bot token');
      process.exit(1);
    }

    logger.success(`   Bot: @${me.username}`);

    // Test OpenRouter
    logger.info('2. Testing OpenRouter API...');
    const response = await chat('Say "Integration test successful!"', config.openrouter.apiKey, {
      maxTokens: 50,
    });

    logger.success('   Response:', response.substring(0, 80));

    logger.success('\n✅ All tests passed!');
    logger.info('Run: ziron telegram connect');

  } catch (err) {
    logger.error('Test failed:', err.message);
    process.exit(1);
  }
}

export default { connectCommand, statusCommand, testCommand };
