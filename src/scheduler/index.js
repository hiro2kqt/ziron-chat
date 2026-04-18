/**
 * ZIRON Scheduler
 * Main entry point for the scheduler system
 */

import logger from '../utils/logger.js';
import { initDatabases, getMasterJobs, getTodayJobs, insertMasterJob, insertTodayJob, insertOneShotJobs, deleteMasterJob, disableTodayJobsByName } from './db.js';
import { syncTodayJobs, scheduleNextDaySync } from './sync.js';
import { startPoller } from './poller.js';

let schedulerInitialized = false;

/**
 * Initialize the scheduler system
 * @param {Function} sendMessage - Function to send Telegram messages
 * @returns {Promise<void>}
 */
export async function initScheduler(sendMessage) {
  if (schedulerInitialized) {
    logger.warn('[Scheduler] Already initialized');
    return;
  }

  try {
    logger.info('[Scheduler] Initializing...');

    // Initialize databases
    initDatabases();

    // Sync today's jobs from master
    await syncTodayJobs();

    // Schedule next midnight sync
    scheduleNextDaySync();

    // Start polling for jobs to fire
    startPoller(sendMessage);

    schedulerInitialized = true;
    logger.success('[Scheduler] Started successfully');
  } catch (err) {
    logger.error('[Scheduler] Initialization failed:', err);
    throw err;
  }
}

/**
 * Add a recurring job
 * @param {Object} params - Job parameters
 * @param {string} params.name - Job name
 * @param {Array<number>} params.repeatDays - Days of week (0=Sun, 1=Mon, etc). Empty = every day
 * @param {Array<Object>} params.timeTriggers - Time triggers with message and buttons
 * @param {string} params.chatId - Chat ID
 * @returns {Promise<Object>} Created job
 */
export async function addRecurringJob(params) {
  const { name, repeatDays = [], timeTriggers, chatId } = params;

  // Insert master job
  const job = insertMasterJob({
    name,
    repeat_days: repeatDays,
    time_triggers: timeTriggers,
    chat_id: chatId,
    enabled: true,
  });

  // Re-sync today's jobs to include the new job if applicable
  await syncTodayJobs();

  logger.info(`[Scheduler] Recurring job added: ${name}`);

  return job;
}

/**
 * Add a oneshot job for today
 * @param {Object} params - Job parameters
 * @param {string} params.name - Job name
 * @param {string} params.chatId - Chat ID
 * @param {string} params.fireAt - Fire time HH:MM
 * @param {string} params.message - Message text
 * @param {Array} params.buttons - Inline keyboard buttons
 * @returns {Promise<Object>} Created job
 */
export async function addOneshotJob(params) {
  const { name, chatId, fireAt, message, buttons = [] } = params;
  const today = new Date().toISOString().split('T')[0];

  const job = insertTodayJob({
    name,
    chat_id: chatId,
    fire_at: fireAt,
    message,
    buttons,
    source: 'oneshot',
    date: today,
    enabled: true,
    fired: false,
  });

  logger.info(`[Scheduler] Oneshot job added: ${name} at ${fireAt}`);

  return job;
}

/**
 * Add multiple oneshot jobs for an interval
 * @param {Object} params - Interval parameters
 * @param {string} params.name - Job name
 * @param {string} params.chatId - Chat ID
 * @param {string} params.fromTime - Start time HH:MM
 * @param {string} params.toTime - End time HH:MM
 * @param {number} params.intervalMinutes - Interval in minutes
 * @param {string} params.message - Message text
 * @param {Array} params.buttons - Inline keyboard buttons
 * @returns {Promise<number>} Number of jobs created
 */
export async function addOneshotInterval(params) {
  const count = insertOneShotJobs(params);

  logger.info(`[Scheduler] Oneshot interval added: ${params.name} (${count} jobs)`);

  return count;
}

/**
 * Disable all today jobs matching a name
 * @param {string} name - Job name
 * @param {string} dateStr - Date YYYY-MM-DD
 * @returns {Promise<number>} Number of jobs disabled
 */
export async function disableJobsByName(name, dateStr) {
  const count = disableTodayJobsByName(name, dateStr);

  logger.info(`[Scheduler] Disabled ${count} jobs named: ${name}`);

  return count;
}

/**
 * List today's pending jobs for a chat
 * @param {string} chatId - Chat ID
 * @returns {Promise<Array>} List of pending jobs
 */
export async function listTodayJobs(chatId) {
  const today = new Date().toISOString().split('T')[0];
  const allJobs = getTodayJobs(today);

  const filtered = allJobs.filter(job => String(job.chat_id) === String(chatId));

  logger.debug(`[Scheduler] Listed ${filtered.length} today jobs for chat ${chatId}`);

  return filtered;
}

/**
 * List all master jobs for a chat
 * @param {string} chatId - Chat ID
 * @returns {Promise<Array>} List of master jobs
 */
export async function listMasterJobs(chatId) {
  const allJobs = getMasterJobs();

  const filtered = allJobs.filter(job => String(job.chat_id) === String(chatId));

  logger.debug(`[Scheduler] Listed ${filtered.length} master jobs for chat ${chatId}`);

  return filtered;
}

/**
 * Delete a master job
 * @param {string} jobId - Job ID
 * @returns {Promise<boolean>} True if deleted
 */
export async function deleteJob(jobId) {
  const deleted = deleteMasterJob(jobId);

  if (deleted) {
    logger.info(`[Scheduler] Deleted job: ${jobId}`);
  } else {
    logger.warn(`[Scheduler] Job not found: ${jobId}`);
  }

  return deleted;
}

export default {
  initScheduler,
  addRecurringJob,
  addOneshotJob,
  addOneshotInterval,
  disableJobsByName,
  listTodayJobs,
  listMasterJobs,
  deleteJob,
};
