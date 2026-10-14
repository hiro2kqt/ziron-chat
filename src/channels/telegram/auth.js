/**
 * Telegram inbound authorization
 *
 * Two config fields are enforced independently:
 *   telegram.chatId        — where outbound messages go (routing, not auth)
 *   telegram.allowedUserIds — who may send inbound updates (auth, this module)
 *
 * IMPORTANT: authorization is always on ctx.from.id (the human sender),
 * never on ctx.chat.id (the conversation). In a group those differ.
 */

import logger from '../../utils/logger.js';

const PAYLOAD_MAX = 200;

/**
 * Returns true if this update is authorized to be processed.
 *
 * When allowedUserIds is empty the bot is open to everyone (default).
 * When non-empty only listed user IDs pass.
 *
 * All IDs are compared as strings. Telegram user IDs can exceed 32-bit;
 * never coerce to Number.
 *
 * @param {Object} config - Full ziron config
 * @param {Object} ctx    - Grammy context
 * @returns {boolean}
 */
export function isAuthorized(config, ctx) {
  // allowedUserIds is normalized to string[] by loadConfig — no re-coercion needed
  const allowedUserIds = config.telegram?.allowedUserIds ?? [];

  // Empty allowlist → open access, preserves today's behavior
  if (allowedUserIds.length === 0) return true;

  // ctx.from is absent for channel posts and certain automated updates.
  // Treat missing from as unauthorized when an allowlist is configured.
  if (!ctx.from) return false;

  // Note: anonymous group admins post as user ID 1087968824 (GroupAnonymousBot),
  // not their real ID. They are not special-cased and will be denied unless
  // explicitly listed.

  return allowedUserIds.includes(String(ctx.from.id));
}

/**
 * Grammy middleware that enforces telegram.allowedUserIds.
 *
 * Register this with bot.use() BEFORE any command, message, or callback handler
 * so no API calls are made for unauthorized users.
 *
 * Logs every inbound update exactly once, before the auth decision, at
 * info (allowed) or warn (rejected). Grep `[Inbound]` for the full traffic log.
 *
 * Rejection behavior:
 *   - Regular updates: silent discard, no reply (avoids confirming bot existence).
 *   - Callback queries: answerCallbackQuery() with no text (required by Telegram
 *     to clear the button loading state; reveals nothing to the sender).
 *
 * @param {Object} config - Full ziron config (read once at registration time)
 * @returns {Function} Grammy middleware (ctx, next) => Promise<void>
 */
export function createAuthMiddleware(config) {
  // allowedUserIds is normalized to string[] by loadConfig — no re-coercion needed
  const allowedUserIds = config.telegram?.allowedUserIds ?? [];
  const restricted = allowedUserIds.length > 0;

  return async (ctx, next) => {
    // Auth decision — computed once, used for both logging and enforcement
    const authorized = !restricted || (!!ctx.from && allowedUserIds.includes(String(ctx.from.id)));

    // Log every inbound update in one stable, greppable line.
    // Wrapped in try/catch so a broken log can never kill the middleware chain.
    try {
      const userId      = ctx.from ? String(ctx.from.id) : 'unknown';
      const username    = ctx.from?.username ?? '-';
      const firstName   = ctx.from?.first_name ?? '';
      const lastName    = ctx.from?.last_name  ?? '';
      const displayName = [firstName, lastName].filter(Boolean).join(' ') || 'unknown';
      const chatId      = ctx.chat ? String(ctx.chat.id) : 'unknown';
      const chatType    = ctx.chat?.type ?? 'unknown';

      let kind;
      let rawPayload;
      if (ctx.callbackQuery) {
        kind = 'callback';
        rawPayload = String(ctx.callbackQuery?.data ?? '');
      } else if (ctx.message?.text?.startsWith('/')) {
        kind = 'command';
        rawPayload = ctx.message.text;
      } else if (ctx.message?.text != null) {
        kind = 'text';
        rawPayload = ctx.message.text;
      } else {
        kind = 'other';
        rawPayload = '';
      }

      const collapsed = rawPayload.replace(/\n/g, '\\n');
      const payload = collapsed.length > PAYLOAD_MAX
        ? `${collapsed.slice(0, PAYLOAD_MAX)}…(${rawPayload.length} chars)`
        : collapsed;

      const decision = authorized ? 'allowed' : 'rejected';
      const line = `[Inbound] user=${userId} @${username} "${displayName}" chat=${chatId} type=${chatType} kind=${kind} decision=${decision} | ${payload}`;

      if (authorized) {
        logger.info(line);
      } else {
        logger.warn(line);
      }
    } catch (logErr) {
      logger.warn('[Inbound] log error:', logErr?.message ?? String(logErr));
    }

    // Authorization enforcement — behavior unchanged from before
    if (authorized) return next();

    // Must answer callback queries to clear the Telegram loading spinner
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery();
    }
    // All other update types: silently discarded, no next() call
  };
}
