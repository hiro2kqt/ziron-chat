/**
 * BE Watcher Service
 * Queries PM2 and Docker state, manages baseline snapshots, diffs status.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connectMongo } from '../db/mongo.js';
import BeSnapshot from '../db/models/BeSnapshot.js';
import logger from '../utils/logger.js';

const execFileAsync = promisify(execFile);

const PM2_DOWN_STATUSES = new Set(['stopped', 'errored', 'stopping', 'launching', 'one-launch-status']);

// ─── Queries ────────────────────────────────────────────────────────────────

/**
 * Query PM2 for current process list.
 * @returns {Promise<Array<{name, pid, pm_id, status}>>}
 */
export async function queryPm2() {
  try {
    const { stdout } = await execFileAsync('pm2', ['jlist'], { timeout: 10000 });
    const raw = JSON.parse(stdout);
    return raw.map(p => ({
      name:   p.name,
      pid:    p.pid ?? null,
      pm_id:  p.pm_id,
      status: p.pm2_env?.status ?? 'unknown',
    }));
  } catch (err) {
    logger.warn('[BeWatcher] PM2 query failed:', err.message);
    return [];
  }
}

/**
 * Query Docker for all container statuses.
 * @returns {Promise<Array<{id, name, image, status, health}>>}
 */
export async function queryDocker() {
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['ps', '-a', '--format', '{{json .}}'],
      { timeout: 10000 },
    );
    return stdout
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(line => {
        const c = JSON.parse(line);
        const healthMatch = c.Status?.match(/\((.+?)\)/);
        return {
          id:     c.ID,
          name:   c.Names,
          image:  c.Image,
          status: c.Status,
          health: healthMatch ? healthMatch[1] : null,
        };
      });
  } catch (err) {
    logger.warn('[BeWatcher] Docker query failed:', err.message);
    return [];
  }
}

// ─── Snapshot (write-only, CLI only) ────────────────────────────────────────

/**
 * Take a baseline snapshot — query current state and save to MongoDB.
 * This is the ONLY function that writes to BeSnapshot.
 * Call only from `ziron be snapshot` CLI command.
 * @param {string} mongoUri
 * @returns {Promise<Object>} saved snapshot doc
 */
export async function takeSnapshot(mongoUri) {
  await connectMongo(mongoUri);

  const [pm2, docker] = await Promise.all([queryPm2(), queryDocker()]);

  const doc = await BeSnapshot.findByIdAndUpdate(
    'singleton',
    { _id: 'singleton', createdAt: new Date(), pm2, docker },
    { upsert: true, new: true, overwrite: true },
  );

  logger.info(`[BeWatcher] Snapshot saved — ${pm2.length} PM2 processes, ${docker.length} Docker containers`);
  return doc;
}

// ─── Status check (read + compare, never writes) ────────────────────────────

/**
 * Compare current state against the saved baseline snapshot.
 * Does NOT write to MongoDB.
 * @param {string} mongoUri
 * @returns {Promise<{ok: false, reason: string} | {ok: true, results: Array, snapshot: Object}>}
 */
export async function checkStatus(mongoUri) {
  await connectMongo(mongoUri);

  const baseline = await BeSnapshot.findById('singleton').lean();
  if (!baseline) {
    return { ok: false, reason: 'No snapshot found. Run `ziron be snapshot` first.' };
  }

  const [currentPm2, currentDocker] = await Promise.all([queryPm2(), queryDocker()]);

  const results = [];

  // Check PM2 processes
  for (const expected of baseline.pm2) {
    const current = currentPm2.find(p => p.name === expected.name);
    const currentStatus = current?.status ?? 'missing';
    const isDown = !current || PM2_DOWN_STATUSES.has(currentStatus);
    results.push({
      name:     expected.name,
      type:     'pm2',
      expected: expected.status,
      current:  currentStatus,
      isDown,
    });
  }

  // Check Docker containers
  for (const expected of baseline.docker) {
    const current = currentDocker.find(c => c.name === expected.name);
    const currentStatus = current?.status ?? 'missing';
    const isDown = !current || !currentStatus.startsWith('Up');
    results.push({
      name:     expected.name,
      type:     'docker',
      expected: expected.status,
      current:  currentStatus,
      isDown,
    });
  }

  return { ok: true, results, snapshot: baseline };
}

// ─── Formatting ──────────────────────────────────────────────────────────────

/**
 * Format checkStatus results as a Telegram message.
 * @param {{ok: boolean, reason?: string, results?: Array, snapshot?: Object}} statusResult
 * @returns {string}
 */
export function formatStatusMessage(statusResult) {
  if (!statusResult.ok) {
    return `⚠️ ${statusResult.reason}`;
  }

  const { results, snapshot } = statusResult;

  if (!results.length) {
    return '📸 No services in baseline snapshot.';
  }

  const lines = results.map(r => {
    const label = `${r.name} (${r.type})`;
    return r.isDown
      ? `❌ ${label} — was: \`${r.expected}\` → now: \`${r.current}\``
      : `✅ ${label} — ${r.current}`;
  });

  const allUp = results.every(r => !r.isDown);
  const header = allUp ? '✅ All services running' : '🚨 Service issues detected';
  const ts = new Date(snapshot.createdAt).toLocaleString();

  return `${header}\n\n${lines.join('\n')}\n\n_Baseline: ${ts}_`;
}

/**
 * Format a short alert message for down services (used by cronjob).
 * @param {Array} downItems — filtered results where isDown === true
 * @returns {string}
 */
export function formatAlertMessage(downItems) {
  const lines = downItems.map(r =>
    `❌ ${r.name} (${r.type}) — was: \`${r.expected}\` → now: \`${r.current}\``,
  );
  return `🚨 *Service alert*\n\n${lines.join('\n')}`;
}

// ─── Watcher (cronjob) ───────────────────────────────────────────────────────

/**
 * Start the BE watcher interval.
 * On each tick: checkStatus(), alert if anything is down.
 * Never calls takeSnapshot().
 * @param {Function} sendMessage — async (chatId, text, options) => void
 * @param {Object} config — full ziron config
 */
export function initBeWatcher(sendMessage, config) {
  const chatId = config.beWatcher?.chatId;
  const intervalMinutes = config.beWatcher?.intervalMinutes ?? 5;
  const mongoUri = config.database?.mongoUri;

  if (!chatId) {
    logger.warn('[BeWatcher] beWatcher.chatId not configured — alerts disabled');
    return;
  }

  if (!mongoUri) {
    logger.warn('[BeWatcher] No MongoDB URI — BE watcher cannot run');
    return;
  }

  let firstTick = true;

  const tick = async () => {
    if (firstTick) {
      firstTick = false;
      return; // Skip first tick — no meaningful diff without a prior check
    }
    try {
      const result = await checkStatus(mongoUri);
      if (!result.ok) {
        logger.info('[BeWatcher] Tick skipped:', result.reason);
        return;
      }
      const down = result.results.filter(r => r.isDown);
      if (down.length > 0) {
        const msg = formatAlertMessage(down);
        await sendMessage(chatId, msg, { parse_mode: 'Markdown' });
        logger.warn(`[BeWatcher] Alert sent — ${down.length} service(s) down`);
      }
    } catch (err) {
      logger.error('[BeWatcher] Tick error:', err.message);
    }
  };

  const intervalMs = intervalMinutes * 60 * 1000;
  setInterval(tick, intervalMs);
  logger.info(`[BeWatcher] Watcher started — checking every ${intervalMinutes}m`);
}
