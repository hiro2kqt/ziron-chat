/**
 * Telegram Bot Client
 * Uses Grammy for Telegram Bot API
 */

import { Bot } from 'grammy';
import logger from '../../utils/logger.js';
import { replyTo } from './reply.js';

/**
 * @typedef {Object} TelegramClient
 * @property {Bot} bot - Grammy bot instance
 * @property {Function} start - Start the bot
 * @property {Function} stop - Stop the bot
 * @property {Function} sendMessage - Send a message
 */

/**
 * Create Telegram bot client
 * @param {string} botToken - Bot token from @BotFather
 * @param {string} [apiRoot] - Optional local Bot API server root URL (e.g. http://localhost:8082)
 * @returns {TelegramClient}
 */
export function createClient(botToken, apiRoot = '') {
  if (!botToken) {
    throw new Error('Telegram bot token required');
  }

  // grammY default per-request timeout is 500s; a stuck send would hold the
  // scheduler tick (and every later reminder) for that long (must exceed the 30s getUpdates long-poll)
  const clientOpts = { timeoutSeconds: 60, ...(apiRoot ? { apiRoot } : {}) };
  const bot = new Bot(botToken, { client: clientOpts });
  let isRunning = false;

  return {
    bot,

    /**
     * Start the bot
     * @param {Object} handlers - Message handlers
     */
    async start(handlers = {}) {
      if (isRunning) {
        logger.warn('Bot already running');
        return;
      }

      // Start command
      bot.command('start', async (ctx) => {
        await replyTo(ctx,
          '👋 Hello! I\'m Ziron, an AI assistant powered by OpenRouter.\n\n' +
          'Send me any message and I\'ll respond using AI!'
        );
      });

      // Help command
      bot.command('help', async (ctx) => {
        await replyTo(ctx,
          'Available commands:\n' +
          '/start - Start the bot\n' +
          '/help - Show this message\n' +
          '/ping - Test if bot is alive\n' +
          '/newsession - Start a new conversation\n' +
          '/model - Show current AI model\n' +
          '/tasks - List all scheduled tasks\n' +
          '/task_today - List today\'s tasks\n\n' +
          'Just send me any text message!'
        );
      });

      // New session command
      bot.command('newsession', async (ctx) => {
        if (handlers.onNewSession) {
          await handlers.onNewSession(ctx);
        } else {
          await replyTo(ctx, 'Started new conversation session!');
        }
      });

      // Ping command
      bot.command('ping', async (ctx) => {
        await replyTo(ctx, '🏓 Pong!');
      });

      // Model command
      bot.command('model', async (ctx) => {
        if (handlers.onModel) {
          await handlers.onModel(ctx);
        } else {
          await replyTo(ctx, '🤖 Model info not available.');
        }
      });

      // Tasks command
      bot.command('tasks', async (ctx) => {
        if (handlers.onTasks) {
          await handlers.onTasks(ctx);
        } else {
          await replyTo(ctx, 'No tasks configured.');
        }
      });

      // Task today command
      bot.command('task_today', async (ctx) => {
        if (handlers.onTaskToday) {
          await handlers.onTaskToday(ctx);
        } else {
          await replyTo(ctx, 'No tasks for today.');
        }
      });

      // Check BE command
      bot.command('check_be', async (ctx) => {
        if (handlers.onCheckBe) {
          await handlers.onCheckBe(ctx);
        } else {
          await replyTo(ctx, 'BE watcher not available.');
        }
      });

      // BE snapshot command
      bot.command('be_snapshot', async (ctx) => {
        if (handlers.onBeSnapshot) {
          await handlers.onBeSnapshot(ctx);
        } else {
          await replyTo(ctx, 'BE snapshot not available.');
        }
      });

      // Daily brief on demand: /brief [today|tomorrow]
      bot.command('brief', async (ctx) => {
        if (handlers.onBrief) {
          await handlers.onBrief(ctx);
        } else {
          await replyTo(ctx, 'Brief not available.');
        }
      });

      // Default message handler — registered after commands so commands take priority
      if (handlers.onMessage) {
        bot.on('message:text', async (ctx) => {
          if (ctx.message?.text?.startsWith('/')) return;
          try {
            await handlers.onMessage(ctx);
          } catch (err) {
            logger.error('Message handler error:', err);
            await replyTo(ctx, 'Sorry, an error occurred processing your message.');
          }
        });
      }

      // Error handler
      bot.catch((err) => {
        logger.error('Bot error:', err);
      });

      // Start polling
      await bot.start({
        onStart: async () => {
          isRunning = true;
          logger.success('Telegram bot started');
          try {
            await bot.api.setMyCommands([]);
            await bot.api.setMyCommands([
              { command: 'start',      description: 'Start the bot' },
              { command: 'help',       description: 'Show available commands' },
              { command: 'newsession', description: 'Start a new conversation session' },
              { command: 'ping',       description: 'Check if bot is alive' },
              { command: 'model',      description: 'Show current AI model' },
              { command: 'tasks',      description: 'List all scheduled tasks' },
              { command: 'task_today', description: 'List today\'s tasks' },
              { command: 'check_be',    description: 'Check PM2 and Docker status' },
              { command: 'be_snapshot', description: 'Save current PM2 and Docker state as baseline' },
              { command: 'brief',       description: 'Important study/work/admin items: /brief [today|tomorrow]' },
            ]);
            console.log('[ziron] Telegram commands registered');
          } catch (err) {
            logger.error('Failed to register commands:', err);
          }
        },
      });
    },

    /**
     * Stop the bot
     */
    async stop() {
      if (!isRunning) {
        return;
      }

      await bot.stop();
      isRunning = false;
      logger.info('Telegram bot stopped');
    },

    /**
     * Send a message
     * @param {number|string} chatId - Chat ID
     * @param {string} text - Message text
     * @param {Object} options - Telegram send options (reply_markup, parse_mode, etc)
     */
    async sendMessage(chatId, text, options = {}) {
      logger.info(`[Telegram OUT] Sending to ${chatId}: Payload:`, JSON.stringify(options.reply_markup || {}, null, 2));
      await bot.api.sendMessage(chatId, text, options);
    },

    /**
     * Get bot info
     */
    async getMe() {
      return await bot.api.getMe();
    },
  };
}

/**
 * Validate bot token
 * @param {string} botToken
 * @param {string} [apiRoot]
 * @returns {Promise<Object|null>} Bot info or null if invalid
 */
export async function validateBotToken(botToken, apiRoot = '') {
  try {
    const bot = apiRoot ? new Bot(botToken, { client: { apiRoot } }) : new Bot(botToken);
    const me = await bot.api.getMe();
    return me;
  } catch (err) {
    return null;
  }
}

export default { createClient, validateBotToken };
