/**
 * Scheduler Poller
 * Checks every 3 seconds for jobs to fire
 */

import logger from '../utils/logger.js';
import { getTodayJobs, claimJob, unclaimJob, deletePastTodayJobs } from './db.js';
import { getWeather, formatWeather } from '../tools/providers/weather/index.js';
import { broadcastVoiceEvent } from '../channels/voice/server.js';
import { synthesize } from '../services/voiceService.js';
import { loadConfig } from '../config/index.js';

// Read once at startup; voice is opt-in via config.voice.enabled
const VOICE_ENABLED = loadConfig().voice?.enabled === true;

/**
 * Synthesize a reminder's audio and push it to connected voice dashboards.
 * Best-effort only: a voice-service failure is logged and swallowed here so
 * it can never affect the Telegram delivery that already happened.
 * @param {string} text
 */
async function pushVoiceReminder(text) {
  if (!VOICE_ENABLED) return;
  let audio = null;
  try {
    const { audioBuffer } = await synthesize(text);
    audio = audioBuffer.toString('base64');
  } catch (err) {
    logger.warn('[Scheduler] Voice TTS for reminder push failed:', err.message);
  }
  broadcastVoiceEvent({ type: 'reminder', text, audio });
}

let pollerInterval = null;
let tickInFlight = false;

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
    // A tick that sends (weather fetch, Telegram, TTS) can take longer than
    // 3s; overlapping ticks used to re-read the still-unfired job and send it
    // again (the 3x weather / 2x water duplicates).
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      await checkAndFire(sendMessage);
    } catch (err) {
      logger.error('[Scheduler] Poller error:', err.message);
    } finally {
      tickInFlight = false;
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
  const thresholdDateStr = thresholdDate.toISOString().split('T')[0];

  deletePastTodayJobs(thresholdTimeSec, thresholdDateStr);

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
    // Claim first: exactly one sender per job, even across processes.
    if (!claimJob(job.id)) continue;
    try {
      // Check if this is a tool_call action (e.g., weather)
      if (job.action?.type === 'tool_call') {
        const { tool, args } = job.action;

        if (tool === 'get_weather') {
          // Execute weather tool with saved coordinates (skip geocoding)
          const weatherResult = await getWeather(args);
          const weatherText = formatWeather(weatherResult);

          // Send weather directly without LLM processing
          await sendMessage(job.chat_id, weatherText);

          // Additive push to any connected voice dashboard — Telegram delivery above is unaffected
          pushVoiceReminder(weatherText).catch(() => {});

          logger.success(`[Scheduler] Fired weather tool: ${job.name} to chat ${job.chat_id}`);
          continue;
        }

        // Unknown tool
        logger.warn(`[Scheduler] Unknown tool: ${tool} in job ${job.id}`);
        continue;
      }

      // Standard message job
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

      // The Cancel button (!act:delete) permanently deleted the recurring job
      // and was removed; strip it from jobs created before that
      const keptButtons = safeButtons
        .map(row => row.filter(btn => !String(btn.callback_data || '').startsWith('!act:delete:')))
        .filter(row => row.length > 0);

      // Replace {todayJobId} and <<refId>> placeholder in button callback_data
      const processedButtons = keptButtons.map(row =>
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

      // Additive push to any connected voice dashboard — Telegram delivery above is unaffected
      pushVoiceReminder(job.message).catch(() => {});

      logger.success(`[Scheduler] Fired: ${job.name} to chat ${job.chat_id}`);
    } catch (err) {
      logger.error(`[Scheduler] Failed to fire job ${job.id}:`, err.message);
      // Release the claim so the next tick retries
      unclaimJob(job.id);
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
