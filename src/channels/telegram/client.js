/**
 * Telegram Bot Client
 * Uses Grammy for Telegram Bot API
 */

import { Bot } from 'grammy';
import logger from '../../utils/logger.js';

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
 * @returns {TelegramClient}
 */
export function createClient(botToken) {
  if (!botToken) {
    throw new Error('Telegram bot token required');
  }

  const bot = new Bot(botToken);
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

      // Default message handler
      if (handlers.onMessage) {
        bot.on('message:text', async (ctx) => {
          try {
            await handlers.onMessage(ctx);
          } catch (err) {
            logger.error('Message handler error:', err);
            await ctx.reply('Sorry, an error occurred processing your message.');
          }
        });
      }

      // Start command
      bot.command('start', async (ctx) => {
        await ctx.reply(
          '👋 Hello! I\'m Ziron, an AI assistant powered by OpenRouter.\n\n' +
          'Send me any message and I\'ll respond using AI!'
        );
      });

      // Help command
      bot.command('help', async (ctx) => {
        await ctx.reply(
          'Available commands:\n' +
          '/start - Start the bot\n' +
          '/help - Show this message\n' +
          '/ping - Test if bot is alive\n' +
          '/newsession - Start a new conversation\n' +
          '/history - Show conversation info\n\n' +
          'Just send me any text message!'
        );
      });

      // New session command
      bot.command('newsession', async (ctx) => {
        if (handlers.onNewSession) {
          await handlers.onNewSession(ctx);
        } else {
          await ctx.reply('Started new conversation session!');
        }
      });

      // History command
      bot.command('history', async (ctx) => {
        if (handlers.onHistory) {
          await handlers.onHistory(ctx);
        } else {
          await ctx.reply('Conversation history is available.');
        }
      });

      // Ping command
      bot.command('ping', async (ctx) => {
        await ctx.reply('🏓 Pong!');
      });

      // Error handler
      bot.catch((err) => {
        logger.error('Bot error:', err);
      });

      // Start polling
      await bot.start();
      isRunning = true;
      logger.success('Telegram bot started');
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
 * @returns {Promise<Object|null>} Bot info or null if invalid
 */
export async function validateBotToken(botToken) {
  try {
    const bot = new Bot(botToken);
    const me = await bot.api.getMe();
    return me;
  } catch (err) {
    return null;
  }
}

export default { createClient, validateBotToken };
