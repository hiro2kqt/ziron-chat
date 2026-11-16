/**
 * Daily brief data selection — pure functions, no LLM, no I/O.
 * The brief service fetches raw rows, these functions decide what is relevant
 * for the target day and format it as compact text; only that text is sent to
 * the LLM for wording.
 */

const MONTHS = {
  january: 1, jan: 1, januar: 1, jänner: 1,
  february: 2, feb: 2, februar: 2,
  march: 3, mar: 3, märz: 3, maerz: 3, mär: 3,
  april: 4, apr: 4,
  may: 5, mai: 5,
  june: 6, jun: 6, juni: 6,
  july: 7, jul: 7, juli: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, oktober: 10, okt: 10,
  november: 11, nov: 11,
  december: 12, dec: 12, dezember: 12, dez: 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

/** Categories that are about study/work/admin */
export const BRIEF_CATEGORIES = ['registration', 'exam', 'assignment', 'deadline', 'course', 'announcement'];
/** Categories worth surfacing even without an explicit date */
const URGENT_CATEGORIES = ['registration', 'deadline', 'exam'];

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function iso(y, m, d) {
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const s = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return Number.isNaN(new Date(`${s}T12:00:00Z`).getTime()) ? null : s;
}

/** Year for a day/month without a year: the one closest after (received - 60 days) */
function inferYear(m, d, receivedStr) {
  const y = Number(receivedStr.slice(0, 4));
  const cand = iso(y, m, d);
  if (cand && cand >= addDays(receivedStr, -60)) return y;
  return y + 1;
}

/**
 * Absolute dates (YYYY-MM-DD) mentioned in a text.
 * Handles 16.11.2026 / 16.11. / 16/11 / 2026-11-16 / 16 November (2026) /
 * November 16, 2026 / 16. Nov, plus today/tomorrow/heute/morgen relative to
 * the received date.
 * @param {string} text
 * @param {string} receivedStr - local date the email was received (YYYY-MM-DD)
 * @returns {string[]} sorted unique dates
 */
export function extractDates(text, receivedStr) {
  const out = new Set();
  const t = String(text || '');
  const push = (y, m, d) => {
    const yy = y === undefined || y === '' ? inferYear(Number(m), Number(d), receivedStr)
      : (String(y).length === 2 ? 2000 + Number(y) : Number(y));
    const s = iso(yy, Number(m), Number(d));
    if (s) out.add(s);
  };
  let m;
  const isoRe = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g;
  while ((m = isoRe.exec(t))) out.add(iso(+m[1], +m[2], +m[3]) || '');
  const numRe = /\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|20\d{2}))?(?![\d/])/g;
  while ((m = numRe.exec(t))) {
    // skip times like 10.30 / 12.00 written with a dot: require a plausible day/month
    if (Number(m[2]) > 12) continue;
    push(m[3], m[2], m[1]);
  }
  const dmy = new RegExp(`\\b(\\d{1,2})\\.?\\s+(${MONTH_RE})\\.?(?:\\s+(20\\d{2}))?\\b`, 'gi');
  while ((m = dmy.exec(t))) push(m[3], MONTHS[m[2].toLowerCase()], m[1]);
  const mdy = new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?(?:\\s+(20\\d{2}))?\\b`, 'gi');
  while ((m = mdy.exec(t))) push(m[3], MONTHS[m[1].toLowerCase()], m[2]);
  if (/\b(today|heute)\b/i.test(t)) out.add(receivedStr);
  if (/\b(tomorrow|morgen)\b/i.test(t)) out.add(addDays(receivedStr, 1));
  out.delete('');
  return [...out].sort();
}

/**
 * Pick emails relevant to the target day.
 * @param {Array<{date: Date, category: string, subject: string, summary: string, receivedStr: string}>} emails
 * @param {string} targetDate - YYYY-MM-DD (local)
 * @param {Date} now
 * @param {{aheadDays?: number}} [opts]
 * @returns {Array} emails with .dates and .reason ('due' | 'upcoming' | 'new' | 'pending')
 */
export function selectEmails(emails, targetDate, now, { aheadDays = 3 } = {}) {
  const until = addDays(targetDate, aheadDays);
  const picked = [];
  for (const e of emails) {
    if (!BRIEF_CATEGORIES.includes(e.category)) continue;
    const dates = extractDates(`${e.subject}\n${e.summary}`, e.receivedStr);
    const ageH = (now - new Date(e.date)) / 3600000;
    let reason = null;
    if (dates.includes(targetDate)) reason = 'due';
    else if (dates.some(d => d > targetDate && d <= until)) reason = 'upcoming';
    else if (ageH <= 24) reason = 'new';
    else if (dates.length === 0 && URGENT_CATEGORIES.includes(e.category) && ageH <= 7 * 24) reason = 'pending';
    if (reason) picked.push({ ...e, dates, reason });
  }
  const order = { due: 0, upcoming: 1, new: 2, pending: 3 };
  return picked.sort((a, b) => order[a.reason] - order[b.reason] || new Date(b.date) - new Date(a.date));
}

/**
 * Scheduler items worth a brief: one-shot reminders, date-specific jobs and
 * weekday-specific recurring jobs (e.g. a class on Tue/Thu). Every-day routine
 * jobs (water, medication, sensor checks) and weather jobs are left out.
 * @param {Array<{time: string, name: string, message: string, oneshot: boolean, everyDay: boolean, isTool: boolean}>} items
 */
export function selectSchedule(items) {
  return items.filter(i => !i.isTool && (i.oneshot || !i.everyDay));
}

const REASON_LABEL = { due: 'due on target day', upcoming: 'due within 3 days', new: 'received in last 24h', pending: 'recent, no date given' };

/** Compact text block for the LLM */
export function formatBriefData({ targetDate, schedule, emails }) {
  const sched = schedule.length
    ? schedule.map(s => `- ${s.time} ${s.message || s.name}`).join('\n')
    : '(none)';
  const mails = emails.length
    ? emails.map(e => `- [${e.reason === 'due' ? '!' : ' '}] received ${e.receivedStr} | ${e.category} | ${REASON_LABEL[e.reason]}${e.dates.length ? ` | dates: ${e.dates.join(', ')}` : ''}\n  ${e.subject} — ${e.summary}`).join('\n')
    : '(none)';
  return `Target day: ${targetDate}\n\nScheduler (local time):\n${sched}\n\nEmails:\n${mails}`;
}
