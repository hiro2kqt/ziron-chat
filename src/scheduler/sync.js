/**
 * Scheduler Sync Module
 * Handles daily synchronization from master jobs to today_jobs
 */

import logger from '../utils/logger.js';
import {
  getMasterJobs,
  insertTodayJob,
  disableTodayJobsByName,
} from './db.js';

let syncTimeout = null;

/**
 * Sync today's jobs from master jobs
 * Called at startup and every midnight UTC
 * @returns {Promise<void>}
 */
export async function syncTodayJobs() {
  try {
    // Get current UTC date and day of week
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const dayOfWeek = now.getUTCDay(); // 0 = Sunday, 1 = Monday, ...

    logger.info(`[Scheduler] Syncing jobs for ${dateStr} (day ${dayOfWeek})`);

    // Disable all existing recurring today_jobs for today
    // This prevents duplicates when sync runs multiple times
    const allJobs = getMasterJobs();
    for (const job of allJobs) {
      for (const trigger of job.time_triggers || []) {
        disableTodayJobsByName(job.name, dateStr);
      }
    }

    // Get all enabled master jobs
    const masterJobs = getMasterJobs();
    let syncedCount = 0;

    for (const job of masterJobs) {
      // Check if job should run today
      const repeatDays = job.repeat_days || [];
      const shouldRunToday = repeatDays.length === 0 || repeatDays.includes(dayOfWeek);

      if (!shouldRunToday) {
        logger.debug(`[Scheduler] Skipping job ${job.name} (not scheduled for day ${dayOfWeek})`);
        continue;
      }

      // Parse time triggers
      const triggers = job.time_triggers || [];

      for (const trigger of triggers) {
        // Replace {jobId} placeholder in button callback_data
        const buttons = (trigger.buttons || []).map(row =>
          row.map(btn => ({
            ...btn,
            callback_data: btn.callback_data.replace(/{jobId}/g, job.id),
          }))
        );

        // Insert today_job
        insertTodayJob({
          job_id: job.id,
          name: job.name,
          chat_id: job.chat_id,
          fire_at: trigger.time,
          message: trigger.message,
          buttons,
          source: 'recurring',
          date: dateStr,
        });

        syncedCount++;
      }
    }

    logger.success(`[Scheduler] Synced ${syncedCount} jobs for today`);
  } catch (err) {
    logger.error('[Scheduler] Sync failed:', err.message);
  }
}

/**
 * Calculate milliseconds until next UTC midnight
 * @returns {number} Milliseconds until midnight
 */
function msUntilNextMidnightUTC() {
  const now = new Date();
  const tomorrow = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0, 0, 0, 0
    )
  );
  return tomorrow.getTime() - now.getTime();
}

/**
 * Schedule the next daily sync at UTC midnight
 * @returns {void}
 */
export function scheduleNextDaySync() {
  // Clear any existing timeout
  if (syncTimeout) {
    clearTimeout(syncTimeout);
    syncTimeout = null;
  }

  const msUntilMidnight = msUntilNextMidnightUTC();

  logger.info(`[Scheduler] Next sync in ${Math.round(msUntilMidnight / 1000 / 60)} minutes`);

  syncTimeout = setTimeout(async () => {
    logger.info('[Scheduler] UTC midnight - running daily sync');
    await syncTodayJobs();
    scheduleNextDaySync(); // Schedule next day's sync
  }, msUntilMidnight);
}

/**
 * Stop the sync scheduler
 * @returns {void}
 */
export function stopSync() {
  if (syncTimeout) {
    clearTimeout(syncTimeout);
    syncTimeout = null;
    logger.info('[Scheduler] Sync scheduler stopped');
  }
}

export default {
  syncTodayJobs,
  scheduleNextDaySync,
  stopSync,
};
