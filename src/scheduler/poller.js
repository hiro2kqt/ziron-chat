/**
 * Scheduler Poller
 * Checks every 3 seconds for jobs to fire
 */

import logger from '../utils/logger.js';
import { getTodayJobs, markFired, deletePastTodayJobs } from './db.js';

let pollerInterval = null;

/**
 * Start the polling loop
 * @param {Function} sendMessage - Function to send Telegram messages
 * @returns {void}
 */
export function startPoller(sendMessage) {
  if (pollerInterval) {
    logger.warn('[Scheduler] Poller already running');
    return;
  }

  logger.info('[Scheduler] Starting poller (every 3 seconds)');

  pollerInterval = setInterval(async () => {
    try {
      // logger.debug('[Scheduler] Poller tick...');
      await checkAndFire(sendMessage);
    } catch (err) {
      logger.error('[Scheduler] Poller error:', err.message);
    }
  }, 3000); // 3 seconds
}

/**
 * Check for due jobs and fire them
 * @param {Function} sendMessage - Function to send Telegram messages
 * @returns {Promise<void>}
 */
export async function checkAndFire(sendMessage) {
  // Get current UTC time and date
  const now = new Date();
  
  const h = String(now.getUTCHours()).padStart(2, '0');
  const m = String(now.getUTCMinutes()).padStart(2, '0');
  const s = String(now.getUTCSeconds()).padStart(2, '0');
  
  const currentTimeMin = `${h}:${m}`;
  const currentTimeSec = `${h}:${m}:${s}`;
  const dateStr = now.toISOString().split('T')[0];

  // Disable past jobs that completely missed their time by more than 10 seconds
  const thresholdDate = new Date(now.getTime() - 10000); // 10 seconds ago
  const th = String(thresholdDate.getUTCHours()).padStart(2, '0');
  const tm = String(thresholdDate.getUTCMinutes()).padStart(2, '0');
  const ts = String(thresholdDate.getUTCSeconds()).padStart(2, '0');
  const thresholdTimeSec = `${th}:${tm}:${ts}`;

  deletePastTodayJobs(thresholdTimeSec, dateStr);

  // Get all enabled, unfired jobs for today
  const jobs = getTodayJobs(dateStr);
  if(jobs.length > 0) logger.debug(`[Scheduler] Poller checking ${jobs.length} pending jobs against current time: ${currentTimeSec}`);

  // Filter jobs that should fire at current time
  const dueJobs = jobs.filter(job => {
    if (job.fire_at.length === 5) { // HH:mm format
      return job.fire_at === currentTimeMin;
    } else { // HH:mm:ss format
      // Fire if the job belongs to the current minute and the scheduled second has passed
      return job.fire_at.startsWith(currentTimeMin) && job.fire_at <= currentTimeSec;
    }
  });

  if (dueJobs.length === 0) {
    return; // No jobs to fire
  }

  logger.info(`[Scheduler] Found ${dueJobs.length} jobs to fire at ${currentTimeSec}`);

  // Fire each due job
  for (const job of dueJobs) {
    try {
      // Parse buttons from JSON
      const buttons = job.buttons || [];

      // Check if buttons is a valid 2D array, otherwise reset to empty array
      const isValidFormat = Array.isArray(buttons) && (buttons.length === 0 || Array.isArray(buttons[0]));
      // Check if it's a 1D array instead, and try to wrap it if so
      let safeButtons = [];
      if (isValidFormat) {
        safeButtons = buttons;
      } else if (Array.isArray(buttons) && buttons.length > 0 && typeof buttons[0] === 'object') {
        safeButtons = [buttons]; // Wrap 1D array into 2D array
      }

      // Replace {todayJobId} and <<refId>> placeholder in button callback_data
      const processedButtons = safeButtons.map(row =>
        row.map(btn => ({
          ...btn,
          callback_data: btn.callback_data
            .replace(/{todayJobId}/g, job.id)
            .replace(/<<refId>>/g, job.ref_id || job.id),
        }))
      );

      // Build reply markup
      const replyMarkup = processedButtons.length > 0
        ? { inline_keyboard: processedButtons }
        : undefined;

      // Send message
      await sendMessage(job.chat_id, job.message, {
        reply_markup: replyMarkup,
      });

      // Mark as fired
      markFired(job.id);

      logger.success(`[Scheduler] Fired: ${job.name} to chat ${job.chat_id}`);
    } catch (err) {
      logger.error(`[Scheduler] Failed to fire job ${job.id}:`, err.message);
      // Don't mark as fired if send failed - will retry in next poll
    }
  }
}

/**
 * Stop the poller
 * @returns {void}
 */
export function stopPoller() {
  if (pollerInterval) {
    clearInterval(pollerInterval);
    pollerInterval = null;
    logger.info('[Scheduler] Poller stopped');
  }
}

export default {
  startPoller,
  checkAndFire,
  stopPoller,
};
