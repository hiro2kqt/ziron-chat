/**
 * Telegram Pre-defined Actions Module
 * Intercepts callback queries or messages with specific prefixes
 * to perform quick actions without calling the LLM.
 */

import logger from '../../utils/logger.js';
import {
  deleteJobsByRefId,
  deleteTodayJobsByRefId,
  deleteMasterJobsByRefId,
  getTodayJobById,
  insertTodayJob,
} from '../../scheduler/db.js';

/**
 * Action Registry
 * Maps action names to handler functions
 * @type {Object.<string, Function>}
 */
const ACTION_REGISTRY = {
  /**
   * Done action: delete all today_jobs with this refId
   * Format: done|<refId>
   */
  async done(ctx, parts) {
    const refId = parts.slice(2).join(':');
    const today = new Date().toISOString().split('T')[0];
    const count = deleteTodayJobsByRefId(refId, today);

    if (count > 0) {
      await ctx.answerCallbackQuery({ text: '✅ Xong!', show_alert: false });
      logger.info(`[Action:done] Deleted ${count} jobs with refId: ${refId}`);
    } else {
      await ctx.answerCallbackQuery({ text: '⚠️ Không tìm thấy lịch trình.', show_alert: false });
    }
  },

  /**
   * Delete action: delete all master and today_jobs with this refId
   * Format: delete|<refId>
   */
  async delete(ctx, parts) {
    const refId = parts.slice(2).join(':');
    const result = deleteJobsByRefId(refId);

    if (result.jobsDeleted > 0 || result.todayJobsDeleted > 0) {
      await ctx.answerCallbackQuery({ text: '🗑 Đã xoá', show_alert: false });
      logger.info(`[Action:delete] Deleted jobs with refId: ${refId}`);
    } else {
      await ctx.answerCallbackQuery({ text: '⚠️ Không tìm thấy lịch trình.', show_alert: false });
    }
  },

  /**
   * Snooze action: create new oneshot job after N minutes
   * Format: snooze|<minutes>|<todayJobId>
   */
  async snooze(ctx, parts) {
    const minutes = parseInt(parts[2], 10);
    const todayJobId = parts[3];

    if (isNaN(minutes) || !todayJobId) {
      await ctx.answerCallbackQuery({ text: '❌ Dữ liệu không hợp lệ', show_alert: false });
      return;
    }

    // Get the original job
    const originalJob = getTodayJobById(todayJobId);

    if (!originalJob) {
      await ctx.answerCallbackQuery({ text: '❌ Không tìm thấy lịch trình', show_alert: false });
      return;
    }

    // Calculate new fire time (current time + minutes)
    const now = new Date();
    const fireTime = new Date(now.getTime() + minutes * 60 * 1000);
    const fireAt = `${String(fireTime.getUTCHours()).padStart(2, '0')}:${String(fireTime.getUTCMinutes()).padStart(2, '0')}`;
    const today = new Date().toISOString().split('T')[0];

    // Create new oneshot job
    insertTodayJob({
      name: originalJob.name,
      chat_id: originalJob.chat_id,
      fire_at: fireAt,
      message: originalJob.message,
      buttons: originalJob.buttons,
      source: 'oneshot',
      date: today,
      enabled: true,
      fired: false,
      ref_id: originalJob.ref_id,
    });

    await ctx.answerCallbackQuery({ text: `⏰ Nhắc lại sau ${minutes}p`, show_alert: false });
    logger.info(`[Action:snooze] Snoozed job ${todayJobId} for ${minutes}m`);
  },
};

/**
 * Handle incoming callback queries for quick actions.
 * @param {Object} ctx - Telegram context (grammY)
 * @returns {Promise<boolean>} - Returns true if the action was handled and stopped propagation.
 */
export async function handleInlineAction(ctx) {
  // If it's a callback query
  if (ctx.callbackQuery && ctx.callbackQuery.data) {
    const data = ctx.callbackQuery.data;

    // Check for our custom action prefix
    if (data.startsWith('!act:')) {
      const parts = data.split(':');

      // Expected format: !act:<action>:<payload...>
      if (parts.length >= 3) {
        const action = parts[1];

        try {
          // Look up action in registry
          const handler = ACTION_REGISTRY[action];

          if (handler) {
            await handler(ctx, parts);

            // Remove inline buttons from the original message
            try {
              await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
            } catch (err) {
              // Best effort - message might be too old or already edited
              logger.debug('[Telegram Actions] Could not remove buttons:', err.message);
            }
          } else {
            logger.warn(`[Telegram Actions] Unknown action: ${action}`);
            await ctx.answerCallbackQuery({ text: '⚠️ Lệnh không hợp lệ.' });
          }
        } catch (err) {
          logger.error(`[Telegram Actions] Error handling action ${action}:`, err.message);
          await ctx.answerCallbackQuery({ text: '❌ Có lỗi xảy ra khi xử lý.' });
        }

        return true; // We handled it
      }
    }
  }

  // Add more logic here for incoming text messages with prefixes if needed
  if (ctx.message && ctx.message.text) {
    const text = ctx.message.text;
    if (text.startsWith('!act:')) {
      // Handle similarly, though telegram inline buttons usually send callback queries
      return true;
    }
  }

  return false; // Not handled, let it pass to LLM
}

export default { handleInlineAction };
