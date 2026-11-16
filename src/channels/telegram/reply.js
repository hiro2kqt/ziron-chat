/**
 * Routing-aware reply helpers for the Telegram channel.
 * Call setReplyConfig(config) once at startup before bot polling begins.
 */

import { getForcedChatId } from '../../config/index.js';

let _config = null;

/** @param {Object} config - full ziron config from loadConfig() */
export function setReplyConfig(config) {
  _config = config;
}

/**
 * Reply to the user, honoring telegram.chatId when set.
 * @param {import('grammy').Context} ctx
 * @param {string} text
 * @param {Object} [options]
 */
export async function replyTo(ctx, text, options = {}) {
  const forced = getForcedChatId(_config);
  if (forced) {
    return ctx.api.sendMessage(forced, text, options);
  }
  return ctx.reply(text, options);
}

/**
 * Show typing indicator in the correct chat (originating or forced).
 * @param {import('grammy').Context} ctx
 */
export async function typingTo(ctx) {
  const forced = getForcedChatId(_config);
  if (forced) {
    return ctx.api.sendChatAction(forced, 'typing');
  }
  return ctx.replyWithChatAction('typing');
}
