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

/**
 * Run `work()` (returns the answer text) while keeping the chat alive:
 * typing indicator refreshed every 4.5s, and if the answer takes longer than
 * `delayMs` a visible placeholder message that is then edited into the answer
 * (falls back to a new message if the edit fails, e.g. > 4096 chars).
 * Empty answers just remove the placeholder.
 * @param {import('grammy').Context} ctx
 * @param {() => Promise<string>} work
 * @param {{delayMs?: number, text?: string, onError?: string}} [opts]
 */
export async function replyWithPlaceholder(ctx, work, opts = {}) {
  const { delayMs = 1500, text = '💭 thinking...', onError = '❌ Sorry, I encountered an error generating a response.' } = opts;

  await typingTo(ctx).catch(() => {});
  const typingTimer = setInterval(() => typingTo(ctx).catch(() => {}), 4500);
  let placeholderPromise = null;
  const placeholderTimer = setTimeout(() => {
    placeholderPromise = replyTo(ctx, text).catch(() => null);
  }, delayMs);

  const stop = () => {
    clearTimeout(placeholderTimer);
    clearInterval(typingTimer);
  };

  const deliver = async (body) => {
    stop();
    const placeholder = placeholderPromise ? await placeholderPromise : null;
    if (placeholder) {
      const { chat, message_id: id } = placeholder;
      if (!body) {
        await ctx.api.deleteMessage(chat.id, id).catch(() => {});
        return;
      }
      try { await ctx.api.editMessageText(chat.id, id, body, { parse_mode: 'Markdown' }); return; } catch { /* bad Markdown or too long */ }
      try { await ctx.api.editMessageText(chat.id, id, body); return; } catch { /* e.g. > 4096 chars */ }
      await ctx.api.deleteMessage(chat.id, id).catch(() => {});
    }
    if (!body) return;
    try {
      await replyTo(ctx, body, { parse_mode: 'Markdown' });
    } catch {
      await replyTo(ctx, body);
    }
  };

  try {
    const answer = await work();
    await deliver(answer && answer.trim() ? answer : '');
  } catch (err) {
    await deliver(onError).catch(() => {});
    throw err;
  } finally {
    stop();
  }
}
