/**
 * Daily Brief
 * Morning: what matters TODAY. Evening: what matters TOMORROW.
 * Sources: important emails (MongoDB) + scheduler (today_jobs / master jobs).
 * Data is selected by pure functions (briefData.js) and only that compact
 * text goes to the LLM, which just writes the message.
 * Focus: study, work, administrative tasks and other important matters —
 * routine reminders (water, medication, smoke sensor, weather) are left out.
 *
 * Runs on a 1-minute tick in the user's local time. The sent state is kept in
 * ~/.ziron/brief-state.json and claimed before sending, so a restart or a
 * duplicate tick never sends the same brief twice; a brief missed while the
 * bot was down is sent late (within CATCH_UP_HOURS).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Email from '../db/models/Email.js';
import { getTodayJobs, getMasterJobs } from '../scheduler/db.js';
import { occurrencesForDate } from '../scheduler/sync.js';
import { complete } from '../providers/openrouter.js';
import { getForcedChatId } from '../config/index.js';
import { formatLocal, localDateStr } from '../utils/time.js';
import { addDays, selectEmails, selectSchedule, formatBriefData, BRIEF_CATEGORIES } from './briefData.js';
import logger from '../utils/logger.js';

const STATE_PATH = path.join(os.homedir(), '.ziron', 'brief-state.json');
const EMAIL_LOOKBACK_DAYS = 21;
const MAX_EMAILS = 60;      // fetched from DB before selection
const MAX_SELECTED = 12;    // sent to the LLM after selection
const CATCH_UP_HOURS = 3;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (err) {
    logger.error('[Brief] Failed to save state:', err.message);
  }
}

const VI_WEEKDAYS = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
function weekdayVi(dateStr) {
  return VI_WEEKDAYS[new Date(`${dateStr}T12:00:00Z`).getUTCDay()];
}

// ─── Data fetching (raw rows -> plain objects); selection lives in briefData.js ─

/**
 * All scheduler items whose fire time falls on a LOCAL date, tagged so
 * selectSchedule can filter. Rows are stored by UTC date/time, so a local day
 * spans two UTC dates (e.g. 00:30 Berlin = 23:30 UTC the day before): both
 * are scanned and each instant is converted back to the local date.
 */
export function fetchSchedule(dateStr, todayStr) {
  const masters = new Map(getMasterJobs().map(j => [j.id, j]));
  const everyDay = job => !!job && !(job.specific_dates?.length) && !(job.repeat_days?.length);
  const utcDays = [addDays(dateStr, -1), dateStr, addDays(dateStr, 1)];
  const items = [];
  const push = (utcDate, utcTime, base) => {
    const instant = new Date(`${utcDate}T${utcTime.slice(0, 5)}:00Z`);
    if (localDateStr(instant) !== dateStr) return;
    items.push({ ...base, time: formatLocal(instant, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) });
  };

  // Materialized rows: today's recurring instances + one-shots on any date
  // (snoozes, deadline reminders, future-dated reminders)
  for (const d of utcDays) {
    for (const j of getTodayJobs(d)) {
      push(j.date, j.fire_at, {
        name: j.name,
        message: j.message,
        oneshot: j.source === 'oneshot',
        everyDay: j.source !== 'oneshot' && (masters.has(j.job_id) ? everyDay(masters.get(j.job_id)) : true),
        isTool: j.action?.type === 'tool_call',
      });
    }
  }

  // Future days: recurring/date-specific masters are not materialized yet.
  // Same occurrence math as the midnight sync (DST + midnight carry).
  if (dateStr !== todayStr) {
    for (const job of masters.values()) {
      for (const d of utcDays) {
        for (const { trigger: t, time } of occurrencesForDate(job, d)) {
          push(d, time, {
            name: job.name,
            message: t.message,
            oneshot: false,
            everyDay: everyDay(job),
            isTool: t.action?.type === 'tool_call',
          });
        }
      }
    }
  }
  return items.sort((a, b) => a.time.localeCompare(b.time));
}

/** Important study/work/admin emails from the lookback window */
export async function fetchEmails() {
  const since = new Date(Date.now() - EMAIL_LOOKBACK_DAYS * 86400000);
  const docs = await Email.find({ important: true, date: { $gte: since }, category: { $in: BRIEF_CATEGORIES } })
    .sort({ date: -1 }).limit(MAX_EMAILS).lean();
  return docs.map(d => ({
    date: d.date,
    receivedStr: localDateStr(new Date(d.date)),
    category: d.category,
    subject: d.subject,
    summary: d.summary || d.snippet?.slice(0, 200) || '',
  }));
}

function buildPrompt(kind, targetDate, dataText, nowLocal) {
  const when = kind === 'morning' ? 'hôm nay' : 'ngày mai';
  return `You are Baymax, Hiro's assistant (Hiro: MSc Data Science student at TU Dortmund).
Now: ${nowLocal} (Europe/Berlin). Write the ${kind} brief for ${targetDate} (${when}).
The items below were already selected by code as relevant to that day; just word them.
- Relative words inside an email ("this week", "tomorrow") refer to its received date; skip an item if that period is over.
- Keep exact times, dates and course names. Do not add anything not in the data.
Format: Telegram, Vietnamese, max ~10 lines.
First line exactly: ${kind === 'morning' ? '☀️ *Hôm nay' : '🌙 *Ngày mai'} (${weekdayVi(targetDate)}, ${targetDate.slice(8, 10)}/${targetDate.slice(5, 7)})*
Then "- " bullets: items due that day first, then "Sắp tới" (next 3 days), then new mail. *bold* only for times/deadlines.
Omit any group that has no items — never write lines like "không có" for an empty group.

${dataText}`;
}

/**
 * Build the brief text
 * @param {'morning'|'evening'} kind
 * @param {Object} config
 * @returns {Promise<string>}
 */
export async function buildBrief(kind, config) {
  const todayStr = localDateStr();
  const targetDate = kind === 'morning' ? todayStr : addDays(todayStr, 1);
  const schedule = selectSchedule(fetchSchedule(targetDate, todayStr));
  const emails = selectEmails(await fetchEmails(), targetDate, new Date()).slice(0, MAX_SELECTED);

  const header = `${kind === 'morning' ? '☀️ *Hôm nay' : '🌙 *Ngày mai'} (${weekdayVi(targetDate)}, ${targetDate.slice(8, 10)}/${targetDate.slice(5, 7)})*`;
  // Nothing selected: no LLM call needed
  if (schedule.length === 0 && emails.length === 0) {
    return `${header}\nKhông có việc học/công việc/hành chính quan trọng ${kind === 'morning' ? 'hôm nay' : 'ngày mai'}.`;
  }

  const dataText = formatBriefData({ targetDate, schedule, emails });
  logger.debug(`[Brief] ${kind}: ${schedule.length} schedule item(s), ${emails.length} email(s), ${dataText.length} chars to LLM`);
  const prompt = buildPrompt(kind, targetDate, dataText, formatLocal(new Date()));

  // OpenRouter routes each call to a different upstream; some occasionally
  // return an empty completion, so retry before giving up
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await complete(
      [{ role: 'user', content: prompt }],
      config.providers?.openrouter?.apiKey,
      {
        model: config.tools?.email?.classifierModel || config.providers?.openrouter?.model,
        maxTokens: 3000,
        temperature: 0.3,
        reasoning: { effort: 'low', exclude: true },
        timeoutMs: 120000,
      },
    );
    const text = r.choices?.[0]?.message?.content?.trim();
    if (text) return text;
    logger.warn(`[Brief] Empty completion from ${r.provider || 'provider'} (attempt ${attempt}/3)`);
  }
  throw new Error('Empty brief from LLM after 3 attempts');
}

/**
 * Start the morning/evening brief timer
 * @param {Function} sendMessage - (chatId, text, options) => Promise
 * @param {Object} config
 */
export function initDailyBrief(sendMessage, config) {
  const cfg = config.dailyBrief || {};
  if (cfg.enabled === false) {
    logger.info('[Brief] Disabled in config');
    return;
  }
  const chatId = getForcedChatId(config);
  if (!chatId) {
    logger.warn('[Brief] No telegram.chatId configured — daily brief disabled');
    return;
  }
  const slots = { morning: cfg.morning || '07:00', evening: cfg.evening || '21:00' };

  const tick = async () => {
    const now = new Date();
    const today = localDateStr(now);
    const hhmm = formatLocal(now, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const toMin = s => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

    for (const [kind, at] of Object.entries(slots)) {
      const late = toMin(hhmm) - toMin(at);
      if (late < 0 || late > CATCH_UP_HOURS * 60) continue;
      const state = loadState();
      if (state[kind] === today) continue;
      // Claim before the slow LLM call so a parallel tick can't double-send
      state[kind] = today;
      saveState(state);
      try {
        const text = await buildBrief(kind, config);
        await sendMessage(chatId, text, { parse_mode: 'Markdown' });
        logger.success(`[Brief] Sent ${kind} brief for ${today}`);
      } catch (err) {
        logger.error(`[Brief] ${kind} brief failed:`, err.message);
        // Release the claim so the next tick retries
        const s = loadState();
        if (s[kind] === today) { delete s[kind]; saveState(s); }
      }
    }
  };

  let running = false;
  const guarded = async () => {
    if (running) return;
    running = true;
    try { await tick(); } finally { running = false; }
  };
  setInterval(guarded, 60 * 1000);
  guarded();
  logger.info(`[Brief] Daily brief at ${slots.morning} (today) and ${slots.evening} (tomorrow), local time`);
}

export default { initDailyBrief, buildBrief };
