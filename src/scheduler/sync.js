/**
 * Scheduler Sync Module
 * Handles daily synchronization from master jobs to today_jobs
 */

import logger from '../utils/logger.js';
import fs from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  getMasterJobs,
  getMasterJobById,
  insertTodayJob,
  disableTodayJobsById,
  deleteTodayJobsByMasterId,
  deletePastTodayJobs,
  updateMasterJob,
} from './db.js';

let syncTimeout = null;

const SYNC_STATE_PATH = join(homedir(), '.ziron', 'scheduler', 'sync-state.json');

function loadSyncState() {
  try {
    const raw = fs.readFileSync(SYNC_STATE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { lastSyncedDate: null };
  }
}

function saveSyncState(state) {
  try {
    fs.writeFileSync(SYNC_STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (err) {
    logger.error('[Scheduler] Failed to save sync state:', err.message);
  }
}

/**
 * Get today's date string in UTC
 * @returns {string} Date in YYYY-MM-DD format
 */
function getTodayDateStr() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Check if a master job should run today
 * @param {Object} job - Master job object
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {boolean} True if job should run today
 */
function shouldRunToday(job, dateStr) {
  // specific_dates overrides repeat_days completely
  if (job.specific_dates && job.specific_dates.length > 0) {
    return job.specific_dates.includes(dateStr);
  }

  const dayOfWeek = new Date().getUTCDay();
  const repeatDays = job.repeat_days || [];
  return repeatDays.length === 0 || repeatDays.includes(dayOfWeek);
}

/**
 * Create today_jobs from a single master job
 * @param {Object} job - Master job object
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {number} Number of today_jobs created
 */
function createTodayJobsFromMaster(job, dateStr) {
  const triggers = job.time_triggers || [];
  let count = 0;

  for (const trigger of triggers) {
    // Check if buttons is a valid 2D array
    const rawButtons = trigger.buttons || [];
    const isValidFormat = Array.isArray(rawButtons) && (rawButtons.length === 0 || Array.isArray(rawButtons[0]));

    let safeButtons = [];
    if (isValidFormat) {
      safeButtons = rawButtons;
    } else if (Array.isArray(rawButtons) && rawButtons.length > 0 && typeof rawButtons[0] === 'object') {
      safeButtons = [rawButtons]; // Wrap 1D into 2D
    }

    // Replace {jobId} and <<refId>> placeholder in button callback_data
    const buttons = safeButtons.map(row =>
      row.map(btn => ({
        ...btn,
        callback_data: btn.callback_data
          .replace(/{jobId}/g, job.id)
          .replace(/<<refId>>/g, job.ref_id || job.id),
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
      ref_id: job.ref_id,
      action: trigger.action || null,
    });

    count++;
  }

  return count;
}

/**
 * Sync today's jobs from master jobs
 * Called at startup and every midnight UTC
 * @returns {Promise<void>}
 */
export async function syncTodayJobs() {
  try {
    const dateStr = getTodayDateStr();

    // Check if already synced today
    const state = loadSyncState();
    if (state.lastSyncedDate === dateStr) {
      logger.info(`[Scheduler] Already synced for ${dateStr}, skipping`);
      return;
    }

    const dayOfWeek = new Date().getUTCDay();

    logger.info(`[Scheduler] Syncing jobs for ${dateStr} (day ${dayOfWeek})`);

    const allJobs = getMasterJobs();
    let syncedCount = 0;

    // Clean up past days' tasks before syncing new ones
    deletePastTodayJobs('00:00:00', dateStr);

    // Disable all existing recurring today_jobs for today
    for (const job of allJobs) {
      disableTodayJobsById(job.id, dateStr);
    }

    // Re-create from master
    for (const job of allJobs) {
      if (shouldRunToday(job, dateStr)) {
        const count = createTodayJobsFromMaster(job, dateStr);
        syncedCount += count;
      } else {
        logger.debug(`[Scheduler] Skipping job ${job.name} (not scheduled for today)`);
      }
      
      // Auto-disable expired specific_dates jobs
      if (job.specific_dates && job.specific_dates.length > 0) {
        const allPast = job.specific_dates.every(d => d < dateStr);
        if (allPast && job.enabled) {
          updateMasterJob(job.id, { enabled: false });
          logger.info(`[Scheduler] Auto-disabled expired specific_dates job: ${job.name}`);
        }
      }
    }

    logger.success(`[Scheduler] Synced ${syncedCount} jobs for today`);
    
    // Save sync state after successful sync
    saveSyncState({ lastSyncedDate: dateStr });
    logger.info(`[Scheduler] Sync state saved for ${dateStr}`);
  } catch (err) {
    logger.error('[Scheduler] Sync failed:', err.message);
  }
}

/**
 * Re-sync a single master job's today_jobs
 * Deletes existing today_jobs and re-creates them if job should run today
 * @param {string} jobId - Master job ID
 * @returns {Promise<void>}
 */
export async function reSyncJob(jobId) {
  try {
    const dateStr = getTodayDateStr();

    // 1. Delete existing today_jobs from this master job
    deleteTodayJobsByMasterId(jobId, dateStr);

    // 2. Load master job
    const job = getMasterJobById(jobId);
    if (!job) {
      logger.debug(`[Scheduler] Job ${jobId} not found or disabled - skipping re-sync`);
      return;
    }

    // 3. Check if should run today
    if (!shouldRunToday(job, dateStr)) {
      logger.debug(`[Scheduler] Job ${job.name} should not run today - skipping`);
      return;
    }

    // 4. Create new today_jobs
    const count = createTodayJobsFromMaster(job, dateStr);

    logger.info(`[Scheduler] Re-synced job: ${job.name} (${count} today_jobs created)`);
  } catch (err) {
    logger.error(`[Scheduler] Re-sync failed for job ${jobId}:`, err.message);
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
    logger.info(`[Scheduler] Midnight sync triggered at ${new Date().toISOString()}`);
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
  reSyncJob,
  scheduleNextDaySync,
  stopSync,
};
