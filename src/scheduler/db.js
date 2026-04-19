/**
 * Scheduler Database Layer
 * Uses better-sqlite3 for master jobs and daily snapshots
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import logger from '../utils/logger.js';

const SCHEDULER_DIR = path.join(os.homedir(), '.ziron', 'scheduler');
const JOBS_DB_PATH = path.join(SCHEDULER_DIR, 'jobs.db');
const TODAY_DB_PATH = path.join(SCHEDULER_DIR, 'today.db');

let jobsDb = null;
let todayDb = null;

/**
 * Initialize both databases with schemas and secure permissions
 * @returns {void}
 */
export function initDatabases() {
  // Ensure directory exists
  if (!fs.existsSync(SCHEDULER_DIR)) {
    fs.mkdirSync(SCHEDULER_DIR, { recursive: true, mode: 0o700 });
  }

  // Set directory permissions
  try {
    fs.chmodSync(SCHEDULER_DIR, 0o700);
  } catch (err) {
    // Best effort on platforms that don't support chmod
  }

  // Initialize jobs.db
  jobsDb = new Database(JOBS_DB_PATH);
  jobsDb.pragma('journal_mode = WAL');

  jobsDb.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      repeat_days TEXT DEFAULT '[]',
      time_triggers TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // Initialize today.db
  todayDb = new Database(TODAY_DB_PATH);
  todayDb.pragma('journal_mode = WAL');

  todayDb.exec(`
    CREATE TABLE IF NOT EXISTS today_jobs (
      id TEXT PRIMARY KEY,
      job_id TEXT,
      name TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      fire_at TEXT NOT NULL,
      message TEXT NOT NULL,
      buttons TEXT DEFAULT '[]',
      enabled INTEGER DEFAULT 1,
      fired INTEGER DEFAULT 0,
      source TEXT DEFAULT 'recurring',
      date TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Add ref_id columns safely
  try { jobsDb.exec("ALTER TABLE jobs ADD COLUMN ref_id TEXT;"); } catch (e) {}
  try { todayDb.exec("ALTER TABLE today_jobs ADD COLUMN ref_id TEXT;"); } catch (e) {}

  // Add action column for tool_call actions (stores JSON)
  try { todayDb.exec("ALTER TABLE today_jobs ADD COLUMN action TEXT;"); } catch (e) {}

  // Set secure file permissions
  try {
    fs.chmodSync(JOBS_DB_PATH, 0o600);
    fs.chmodSync(TODAY_DB_PATH, 0o600);
  } catch (err) {
    // Best effort on platforms that don't support chmod
  }

  logger.info('[Scheduler] Databases initialized');
}

/**
 * Get all enabled master jobs
 * @returns {Array<Object>} List of enabled jobs
 */
export function getMasterJobs() {
  if (!jobsDb) throw new Error('Database not initialized');

  const stmt = jobsDb.prepare(`
    SELECT * FROM jobs WHERE enabled = 1 ORDER BY created_at ASC
  `);

  const rows = stmt.all();

  return rows.map(row => ({
    ...row,
    enabled: Boolean(row.enabled),
    repeat_days: JSON.parse(row.repeat_days || '[]'),
    time_triggers: JSON.parse(row.time_triggers || '[]'),
  }));
}

/**
 * Get a single enabled master job by ID
 * @param {string} jobId - Job ID
 * @returns {Object|null} Job object or null if not found
 */
export function getMasterJobById(jobId) {
  if (!jobsDb) throw new Error('Database not initialized');

  const stmt = jobsDb.prepare(`
    SELECT * FROM jobs WHERE id = ? AND enabled = 1
  `);

  const row = stmt.get(jobId);

  if (!row) return null;

  return {
    ...row,
    enabled: Boolean(row.enabled),
    repeat_days: JSON.parse(row.repeat_days || '[]'),
    time_triggers: JSON.parse(row.time_triggers || '[]'),
  };
}

/**
 * Get today's jobs for a specific date
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {Array<Object>} List of today's jobs
 */
export function getTodayJobs(dateStr) {
  if (!todayDb) throw new Error('Database not initialized');

  const stmt = todayDb.prepare(`
    SELECT * FROM today_jobs
    WHERE date = ? AND enabled = 1 AND fired = 0
    ORDER BY fire_at ASC
  `);

  const rows = stmt.all(dateStr);

  return rows.map(row => ({
    ...row,
    enabled: Boolean(row.enabled),
    fired: Boolean(row.fired),
    buttons: JSON.parse(row.buttons || '[]'),
    action: row.action ? JSON.parse(row.action) : null,
  }));
}

/**
 * Insert a new master job
 * @param {Object} job - Job data
 * @returns {Object} Created job with generated ID
 */
export function insertMasterJob(job) {
  if (!jobsDb) throw new Error('Database not initialized');

  const id = randomUUID();
  const now = new Date().toISOString();

  const stmt = jobsDb.prepare(`
    INSERT INTO jobs (id, name, enabled, repeat_days, time_triggers, chat_id, created_at, updated_at, ref_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    job.name,
    job.enabled !== undefined ? (job.enabled ? 1 : 0) : 1,
    JSON.stringify(job.repeat_days || []),
    JSON.stringify(job.time_triggers || []),
    String(job.chat_id),
    now,
    now,
    job.ref_id || null
  );

  logger.info(`[Scheduler] Master job created: ${job.name} (${id})`);

  return {
    id,
    ...job,
    created_at: now,
    updated_at: now,
  };
}

/**
 * Update a master job
 * @param {string} id - Job ID
 * @param {Object} fields - Fields to update
 * @returns {boolean} True if updated
 */
export function updateMasterJob(id, fields) {
  if (!jobsDb) throw new Error('Database not initialized');

  const now = new Date().toISOString();
  const updates = [];
  const values = [];

  if (fields.name !== undefined) {
    updates.push('name = ?');
    values.push(fields.name);
  }
  if (fields.enabled !== undefined) {
    updates.push('enabled = ?');
    values.push(fields.enabled ? 1 : 0);
  }
  if (fields.repeat_days !== undefined) {
    updates.push('repeat_days = ?');
    values.push(JSON.stringify(fields.repeat_days));
  }
  if (fields.time_triggers !== undefined) {
    updates.push('time_triggers = ?');
    values.push(JSON.stringify(fields.time_triggers));
  }

  if (updates.length === 0) return false;

  updates.push('updated_at = ?');
  values.push(now);
  values.push(id);

  const stmt = jobsDb.prepare(`
    UPDATE jobs SET ${updates.join(', ')} WHERE id = ?
  `);

  const result = stmt.run(...values);

  logger.info(`[Scheduler] Master job updated: ${id}`);

  return result.changes > 0;
}

/**
 * Delete a master job and disable related today jobs
 * @param {string} id - Job ID
 * @returns {boolean} True if deleted
 */
export function deleteMasterJob(id) {
  if (!jobsDb) throw new Error('Database not initialized');
  if (!todayDb) throw new Error('Database not initialized');

  // Delete from master
  const deleteStmt = jobsDb.prepare('DELETE FROM jobs WHERE id = ?');
  const result = deleteStmt.run(id);

  // Disable all today_jobs with this job_id
  const disableStmt = todayDb.prepare('UPDATE today_jobs SET enabled = 0 WHERE job_id = ?');
  disableStmt.run(id);

  logger.info(`[Scheduler] Master job deleted: ${id}`);

  return result.changes > 0;
}

/**
 * Insert a today job
 * @param {Object} job - Today job data
 * @returns {Object} Created job with generated ID
 */
export function insertTodayJob(job) {
  if (!todayDb) throw new Error('Database not initialized');

  const id = randomUUID();
  const now = new Date().toISOString();

  const stmt = todayDb.prepare(`
    INSERT INTO today_jobs (
      id, job_id, name, chat_id, fire_at, message, buttons,
      enabled, fired, source, date, created_at, ref_id, action
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    job.job_id || null,
    job.name,
    String(job.chat_id),
    job.fire_at,
    job.message,
    JSON.stringify(job.buttons || []),
    job.enabled !== undefined ? (job.enabled ? 1 : 0) : 1,
    job.fired ? 1 : 0,
    job.source || 'recurring',
    job.date,
    now,
    job.ref_id || null,
    job.action ? JSON.stringify(job.action) : null
  );

  logger.debug(`[Scheduler] Today job created: ${job.name} at ${job.fire_at}`);

  return {
    id,
    ...job,
    created_at: now,
  };
}

/**
 * Mark a today job as fired
 * @param {string} todayJobId - Today job ID
 * @returns {boolean} True if marked
 */
export function markFired(todayJobId) {
  if (!todayDb) throw new Error('Database not initialized');

  const stmt = todayDb.prepare('UPDATE today_jobs SET fired = 1 WHERE id = ?');
  const result = stmt.run(todayJobId);

  return result.changes > 0;
}

/**
 * Disable all today jobs matching a name for a specific date
 * @param {string} name - Job name
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {number} Number of jobs disabled
 */
export function disableTodayJobsByName(name, dateStr) {
  if (!todayDb) throw new Error('Database not initialized');

  const stmt = todayDb.prepare(`
    UPDATE today_jobs
    SET enabled = 0
    WHERE name = ? AND date = ? AND fired = 0
  `);

  const result = stmt.run(name, dateStr);

  logger.info(`[Scheduler] Disabled ${result.changes} jobs with name: ${name}`);

  return result.changes;
}

/**
 * Disable all today jobs matching a job_id for a specific date
 * @param {string} jobId - Master job ID
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {number} Number of jobs disabled
 */
export function disableTodayJobsById(jobId, dateStr) {
  if (!todayDb) throw new Error('Database not initialized');

  const stmt = todayDb.prepare(`
    UPDATE today_jobs
    SET enabled = 0
    WHERE job_id = ? AND date = ? AND fired = 0
  `);

  const result = stmt.run(jobId, dateStr);

  logger.info(`[Scheduler] Disabled ${result.changes} jobs with job_id: ${jobId}`);

  return result.changes;
}

/**
 * Delete today jobs from a specific master job (recurring only)
 * @param {string} jobId - Master job ID
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {number} Number of jobs deleted
 */
export function deleteTodayJobsByMasterId(jobId, dateStr) {
  if (!todayDb) throw new Error('Database not initialized');

  const stmt = todayDb.prepare(`
    DELETE FROM today_jobs
    WHERE job_id = ? AND source = 'recurring' AND date = ?
  `);

  const result = stmt.run(jobId, dateStr);

  logger.debug(`[Scheduler] Deleted ${result.changes} recurring today jobs for master job: ${jobId}`);

  return result.changes;
}

/**
 * Delete today jobs that have passed their active time
 * @param {string} thresholdTime - Threshold time in HH:mm or HH:mm:ss format
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {number} Number of jobs deleted
 */
export function deletePastTodayJobs(thresholdTime, dateStr) {
  if (!todayDb) throw new Error('Database not initialized');

  const stmt = todayDb.prepare(`
    DELETE FROM today_jobs
    WHERE date < ? OR (date = ? AND fire_at < ?)
  `);

  const result = stmt.run(dateStr, dateStr, thresholdTime);

  if (result.changes > 0) {
    logger.debug(`[Scheduler] Auto-deleted ${result.changes} past jobs before ${dateStr} ${thresholdTime}`);
  }

  return result.changes;
}

/**
 * Insert multiple oneshot jobs for an interval
 * @param {Object} params - Interval parameters
 * @param {string} params.name - Job name
 * @param {string} params.chatId - Chat ID
 * @param {string} params.fromTime - Start time HH:MM
 * @param {string} params.toTime - End time HH:MM
 * @param {number} params.intervalMinutes - Interval in minutes
 * @param {string} params.message - Message text
 * @param {Array} params.buttons - Inline keyboard buttons
 * @returns {number} Number of jobs inserted
 */
export function insertOneShotJobs(params) {
  if (!todayDb) throw new Error('Database not initialized');

  const { name, chatId, fromTime, toTime, intervalMinutes, message, buttons, ref_id } = params;

  // Parse times
  const [fromHour, fromMin] = fromTime.split(':').map(Number);
  const [toHour, toMin] = toTime.split(':').map(Number);

  const fromMinutes = fromHour * 60 + fromMin;
  const toMinutes = toHour * 60 + toMin;

  if (fromMinutes >= toMinutes) {
    throw new Error('fromTime must be before toTime');
  }

  // Generate all fire times
  const fireTimes = [];
  const fromSecs = fromHour * 3600 + fromMin * 60;
  const toSecs = toHour * 3600 + toMin * 60;
  const intervalSecs = Math.round(intervalMinutes * 60);

  if (intervalSecs <= 0) {
    throw new Error('intervalMinutes must be greater than 0');
  }

  for (let secs = fromSecs; secs <= toSecs; secs += intervalSecs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    
    // Use seconds format if sub-minute or if seconds > 0
    if (intervalSecs % 60 !== 0 || s > 0) {
      fireTimes.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`);
    } else {
      fireTimes.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }

  // Get today's date
  const today = new Date().toISOString().split('T')[0];

  // Insert all jobs
  let count = 0;
  for (const fireAt of fireTimes) {
    insertTodayJob({
      name,
      chat_id: chatId,
      fire_at: fireAt,
      message,
      buttons,
      source: 'oneshot',
      date: today,
      ref_id,
    });
    count++;
  }

  logger.info(`[Scheduler] Created ${count} oneshot jobs for interval ${fromTime}-${toTime}`);

  return count;
}

/**
 * Delete today_jobs by ref_id for a specific date
 * @param {string} refId - Reference ID
 * @param {string} dateStr - Date in YYYY-MM-DD format
 * @returns {number} Number of jobs deleted
 */
export function deleteTodayJobsByRefId(refId, dateStr) {
  if (!todayDb) throw new Error('Database not initialized');

  const stmt = todayDb.prepare(`
    DELETE FROM today_jobs
    WHERE ref_id = ? AND date = ? AND fired = 0
  `);

  const result = stmt.run(refId, dateStr);

  logger.info(`[Scheduler] Deleted ${result.changes} today jobs with ref_id: ${refId}`);

  return result.changes;
}

/**
 * Delete master jobs by ref_id
 * @param {string} refId - Reference ID
 * @returns {number} Number of jobs deleted
 */
export function deleteMasterJobsByRefId(refId) {
  if (!jobsDb) throw new Error('Database not initialized');

  const stmt = jobsDb.prepare('DELETE FROM jobs WHERE ref_id = ?');
  const result = stmt.run(refId);

  logger.info(`[Scheduler] Deleted ${result.changes} master jobs with ref_id: ${refId}`);

  return result.changes;
}

/**
 * Get a single today_job by ID
 * @param {string} id - Today job ID
 * @returns {Object|null} Today job or null if not found
 */
export function getTodayJobById(id) {
  if (!todayDb) throw new Error('Database not initialized');

  const stmt = todayDb.prepare('SELECT * FROM today_jobs WHERE id = ?');
  const row = stmt.get(id);

  if (!row) return null;

  return {
    ...row,
    enabled: Boolean(row.enabled),
    fired: Boolean(row.fired),
    buttons: JSON.parse(row.buttons || '[]'),
  };
}

/**
 * Delete jobs and today_jobs by ref_id
 * @param {string} refId - Reference ID
 * @returns {Object} Number of deleted jobs from both tables
 */
export function deleteJobsByRefId(refId) {
  if (!jobsDb || !todayDb) throw new Error('Databases not initialized');

  const deleteJobsStmt = jobsDb.prepare('DELETE FROM jobs WHERE ref_id = ?');
  const jobsResult = deleteJobsStmt.run(refId);

  const deleteTodayStmt = todayDb.prepare('DELETE FROM today_jobs WHERE ref_id = ?');
  const todayResult = deleteTodayStmt.run(refId);

  logger.info(`[Scheduler] Deleted by ref_id ${refId}: ${jobsResult.changes} master, ${todayResult.changes} today`);

  return { jobsDeleted: jobsResult.changes, todayJobsDeleted: todayResult.changes };
}

/**
 * Close database connections
 * @returns {void}
 */
export function closeDatabases() {
  if (jobsDb) {
    jobsDb.close();
    jobsDb = null;
  }
  if (todayDb) {
    todayDb.close();
    todayDb = null;
  }
  logger.info('[Scheduler] Databases closed');
}

export default {
  initDatabases,
  getMasterJobs,
  getMasterJobById,
  getTodayJobs,
  getTodayJobById,
  insertMasterJob,
  updateMasterJob,
  deleteMasterJob,
  insertTodayJob,
  markFired,
  disableTodayJobsByName,
  disableTodayJobsById,
  deleteTodayJobsByMasterId,
  deleteTodayJobsByRefId,
  deleteMasterJobsByRefId,
  deletePastTodayJobs,
  insertOneShotJobs,
  deleteJobsByRefId,
  closeDatabases,
};
