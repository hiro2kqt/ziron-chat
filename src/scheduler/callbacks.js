/**
 * Scheduler Callback Handler
 * Handles Telegram inline button presses
 */

import logger from '../utils/logger.js';
import {
  disableTodayJobsByName,
  disableTodayJobsById,
  deleteMasterJob,
  getTodayJobs,
  insertTodayJob,
} from './db.js';

/**
 * Handle Telegram callback query from inline buttons
 * @param {Object} ctx - Grammy context object
 * @param {Function} addOneshotJob - Function to add oneshot jobs
 * @returns {Promise<void>}
 */
export async function handleCallback(ctx, addOneshotJob) {
  const callbackData = ctx.callbackQuery?.data;

  if (!callbackData) {
    await ctx.answerCallbackQuery('❌ Invalid callback');
    return;
  }

  try {
    const parts = callbackData.split(':');
    const action = parts[0];

    // Get today's date
    const today = new Date().toISOString().split('T')[0];

    switch (action) {
      case 'done': {
        // done:<name>
        const name = parts.slice(1).join(':');
        const count = disableTodayJobsByName(name, today);
        await ctx.answerCallbackQuery(`✅ Đã xong! (${count} nhắc đã tắt)`);
        logger.info(`[Scheduler] Callback: done - disabled ${count} jobs named "${name}"`);
        break;
      }

      case 'snooze': {
        // snooze:<minutes>:<todayJobId>
        const minutes = parseInt(parts[1], 10);
        const todayJobId = parts[2];

        if (isNaN(minutes) || !todayJobId) {
          await ctx.answerCallbackQuery('❌ Invalid snooze data');
          return;
        }

        // Get the original job to copy its data
        const allJobs = getTodayJobs(today);
        const originalJob = allJobs.find(j => j.id === todayJobId);

        if (!originalJob) {
          await ctx.answerCallbackQuery('❌ Job not found');
          return;
        }

        // Calculate new fire time (current time + minutes)
        const now = new Date();
        const fireTime = new Date(now.getTime() + minutes * 60 * 1000);
        const fireAt = `${String(fireTime.getUTCHours()).padStart(2, '0')}:${String(fireTime.getUTCMinutes()).padStart(2, '0')}`;

        // Create new oneshot job
        await addOneshotJob({
          name: originalJob.name,
          chatId: originalJob.chat_id,
          fireAt,
          message: originalJob.message,
          buttons: originalJob.buttons,
        });

        await ctx.answerCallbackQuery(`⏰ Nhắc lại sau ${minutes}p (${fireAt})`);
        logger.info(`[Scheduler] Callback: snooze ${minutes}m for job ${todayJobId}`);
        break;
      }

      case 'skip_today': {
        // skip_today:<todayJobId>
        const todayJobId = parts[1];

        if (!todayJobId) {
          await ctx.answerCallbackQuery('❌ Invalid job ID');
          return;
        }

        // Get the job to find its job_id
        const allJobs = getTodayJobs(today);
        const job = allJobs.find(j => j.id === todayJobId);

        if (!job) {
          await ctx.answerCallbackQuery('❌ Job not found');
          return;
        }

        // Disable all today jobs with this job_id
        const count = job.job_id
          ? disableTodayJobsById(job.job_id, today)
          : disableTodayJobsByName(job.name, today);

        await ctx.answerCallbackQuery(`❌ Đã bỏ qua (${count} nhắc)`);
        logger.info(`[Scheduler] Callback: skip_today - disabled ${count} jobs`);
        break;
      }

      case 'skip_today_all': {
        // skip_today_all:<name>
        const name = parts.slice(1).join(':');
        const count = disableTodayJobsByName(name, today);
        await ctx.answerCallbackQuery(`❌ Đã bỏ tất cả (${count} nhắc)`);
        logger.info(`[Scheduler] Callback: skip_today_all - disabled ${count} jobs named "${name}"`);
        break;
      }

      case 'delete': {
        // delete:<jobId>
        const jobId = parts[1];

        if (!jobId) {
          await ctx.answerCallbackQuery('❌ Invalid job ID');
          return;
        }

        const deleted = deleteMasterJob(jobId);

        if (deleted) {
          await ctx.answerCallbackQuery('🗑 Đã xóa job vĩnh viễn');
          logger.info(`[Scheduler] Callback: delete - deleted master job ${jobId}`);
        } else {
          await ctx.answerCallbackQuery('❌ Job không tồn tại');
        }
        break;
      }

      default:
        await ctx.answerCallbackQuery('❓ Unknown action');
        logger.warn(`[Scheduler] Unknown callback action: ${action}`);
        return;
    }

    // Remove inline buttons from the original message
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    } catch (err) {
      // Best effort - message might be too old or already edited
      logger.debug('[Scheduler] Could not remove buttons:', err.message);
    }
  } catch (err) {
    logger.error('[Scheduler] Callback handler error:', err);
    await ctx.answerCallbackQuery('❌ Có lỗi xảy ra');
  }
}

export default {
  handleCallback,
};
