/**
 * Telegram command group
 * Start bot, status, test commands
 */

import { loadConfig } from '../config/index.js';
import { createClient, validateBotToken } from '../channels/telegram/index.js';
import { chat as openrouterChat } from '../providers/openrouter.js';
import { chat as openaiChat } from '../providers/openai.js';
import { chat as openaiCodexChat } from '../providers/openai-codex.js';
import { handleMessage, resetSession, initScheduler, addOneshotJob, initEmailMonitoring, listTodayJobs, listMasterJobs } from '../gateway.js';
import { handleCallback } from '../scheduler/callbacks.js';
import { handleInlineAction } from '../channels/telegram/actions.js';
import { checkStatus, formatStatusMessage, initBeWatcher, takeSnapshot } from '../services/beWatcher.js';
import logger from '../utils/logger.js';

export async function connectCommand() {
  logger.info('🤖 Starting Telegram bot...\n');

  const config = loadConfig();

  if (!config.telegram.botToken) {
    logger.error('Missing Telegram bot token');
    logger.info('Get a token from @BotFather on Telegram');
    logger.info('Then add to .env: TELEGRAM_BOT_TOKEN=your_token');
    process.exit(1);
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
    const client = createClient(config.telegram.botToken);

    // Get bot info
    const me = await client.getMe();
    logger.success(`Logged in as: @${me.username} (${me.first_name})`);
    logger.info('Bot ID:', me.id);
    logger.info('');

    // Message handlers
    const handlers = {
      onMessage: async (ctx) => {
        const text = ctx.message.text;
        const from = ctx.from.username || ctx.from.first_name;

        logger.info(`[${from}]: ${text}`);

        if (!provider) {
          await ctx.reply('⚠️ No AI provider configured. Cannot respond.');
          return;
        }

        // Send typing indicator
        await ctx.replyWithChatAction('typing');

        try {
          // Use gateway to handle message with conversation history
          const response = await handleMessage({
            channelType: 'telegram',
            channelId: ctx.chat.id,
            userMessage: text,
          });

          logger.info(`[Bot]: ${response.substring(0, 100)}...`);

          try {
            if (response && response.trim() !== '') {
              await ctx.reply(response, { parse_mode: 'Markdown' });
            }
          } catch (err) {
            logger.warn('Markdown parse failed, sending plain text');
            if (response && response.trim() !== '') {
              await ctx.reply(response);
            }
          }

        } catch (err) {
          logger.error('Gateway error:', err.message);
          await ctx.reply('❌ Sorry, I encountered an error generating a response.');
        }
      },

      onNewSession: async (ctx) => {
        try {
          const sessionId = resetSession('telegram', ctx.chat.id);
          logger.info(`New session created for chat ${ctx.chat.id}: ${sessionId}`);
          await ctx.reply('✨ Started a new conversation! Previous messages have been cleared.');
        } catch (err) {
          logger.error('Failed to create new session:', err.message);
          await ctx.reply('❌ Failed to create new session.');
        }
      },

      onModel: async (ctx) => {
        if (!activeModel) {
          await ctx.reply('⚠️ No model configured.');
          return;
        }
        await ctx.reply(`🤖 Current model: ${activeModel}`);
      },

      onTasks: async (ctx) => {
        try {
          const jobs = await listMasterJobs(ctx.chat.id);
          if (!jobs.length) {
            await ctx.reply('No tasks configured.');
            return;
          }
          const lines = jobs.map(j => {
            const times = j.time_triggers.join(', ') || '—';
            return `• ${j.name} [${times}]`;
          });
          await ctx.reply(`📋 Scheduled tasks:\n\n${lines.join('\n')}`);
        } catch (err) {
          logger.error('Failed to list tasks:', err.message);
          await ctx.reply('❌ Failed to retrieve tasks.');
        }
      },

      onTaskToday: async (ctx) => {
        try {
          const jobs = await listTodayJobs(ctx.chat.id);
          if (!jobs.length) {
            await ctx.reply('No tasks for today.');
            return;
          }
          const lines = jobs.map(j => {
            const status = j.fired ? '✅' : '⏳';
            return `${status} ${j.name} @ ${j.fire_at}`;
          });
          await ctx.reply(`📅 Today's tasks:\n\n${lines.join('\n')}`);
        } catch (err) {
          logger.error('Failed to list today tasks:', err.message);
          await ctx.reply('❌ Failed to retrieve today\'s tasks.');
        }
      },

      onCheckBe: async (ctx) => {
        try {
          const result = await checkStatus(config.database?.mongoUri);
          await ctx.reply(formatStatusMessage(result), { parse_mode: 'Markdown' });
        } catch (err) {
          logger.error('Failed to check BE status:', err.message);
          await ctx.reply('❌ Failed to check service status.');
        }
      },

      onBeSnapshot: async (ctx) => {
        try {
          const doc = await takeSnapshot(config.database?.mongoUri);
          const ts = new Date(doc.createdAt).toLocaleString();
          await ctx.reply(
            `📸 Snapshot saved\n\n` +
            `PM2 processes: ${doc.pm2.length}\n` +
            `Docker containers: ${doc.docker.length}\n` +
            `Saved at: ${ts}`,
          );
        } catch (err) {
          logger.error('Failed to take BE snapshot:', err.message);
          await ctx.reply('❌ Failed to take snapshot.');
        }
      },
    };

    // Initialize scheduler before bot starts
    const sendMessage = async (chatId, text, options = {}) => {
      if (!text || text.trim() === '') {
        return; // Don't send empty messages
      }
      await client.sendMessage(chatId, text, {
        parse_mode: 'Markdown',
        ...options,
      });
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

    // Start BE watcher
    try {
      initBeWatcher(sendMessage, config);
    } catch (err) {
      logger.error('BE watcher initialization failed:', err.message);
      logger.warn('Bot will continue without BE watcher');
    }

    // Register callback query handler for scheduler buttons
    client.bot.on('callback_query:data', async (ctx) => {
      const from = ctx.from.username || ctx.from.first_name;
      logger.info(`[Telegram IN] Button clicked by ${from}: ${ctx.callbackQuery.data}`);
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
    const me = await validateBotToken(config.telegram.botToken);

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
    const me = await validateBotToken(config.telegram.botToken);

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
