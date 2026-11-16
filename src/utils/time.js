/**
 * Time Utility Functions
 * Centralized date/time operations
 */

/**
 * Get date range for last N days
 * @param {number} days - Number of days to look back
 * @returns {Object} Object with start and end Date objects
 */
export function getDateRange(days) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);

  return {
    start,
    end,
  };
}

/**
 * Parse ISO date string to Date object
 * @param {string} isoString - ISO date string (YYYY-MM-DD or full ISO)
 * @returns {Date} Date object
 */
export function parseISODate(isoString) {
  return new Date(isoString);
}

/**
 * Get start of day (00:00:00) for a date
 * @param {Date} date - Input date
 * @returns {Date} Start of day
 */
export function getStartOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Get end of day (23:59:59) for a date
 * @param {Date} date - Input date
 * @returns {Date} End of day
 */
export function getEndOfDay(date) {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * Format date for display
 * @param {Date} date - Date to format
 * @returns {string} Formatted date string
 */
export function formatDate(date) {
  return date.toISOString().split('T')[0];
}

/**
 * Parse relative time expressions
 * @param {string} input - Relative time like "7 days ago", "last week"
 * @returns {Object|null} Date range or null if can't parse
 */
export function parseRelativeTime(input) {
  const lowerInput = input.toLowerCase().trim();

  // Match "N days ago" or "last N days"
  const daysMatch = lowerInput.match(/(\d+)\s*days?/);
  if (daysMatch) {
    const days = parseInt(daysMatch[1]);
    return getDateRange(days);
  }

  // Match "last week"
  if (lowerInput.includes('last week')) {
    return getDateRange(7);
  }

  // Match "last month"
  if (lowerInput.includes('last month')) {
    return getDateRange(30);
  }

  // Match "yesterday"
  if (lowerInput.includes('yesterday')) {
    return getDateRange(1);
  }

  // Match "today"
  if (lowerInput.includes('today')) {
    return getDateRange(0);
  }

  return null;
}

export default {
  getDateRange,
  parseISODate,
  getStartOfDay,
  getEndOfDay,
  formatDate,
  parseRelativeTime,
};

/**
 * UTC offset in minutes for a timezone at a given instant.
 * Accepts IANA names ("Europe/Berlin", DST-aware) or fixed "GMT+2"/"UTC+2"/"UTC".
 * @param {string} tz
 * @param {Date} [at=new Date()]
 * @returns {number} e.g. 60 for CET, 120 for CEST
 */
export function getTzOffsetMinutes(tz, at = new Date()) {
  const s = String(tz || 'UTC').trim();
  const fixed = s.toUpperCase().match(/^(?:GMT|UTC)\s*(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/);
  if (fixed) {
    if (!fixed[1]) return 0;
    const mins = Number(fixed[2]) * 60 + Number(fixed[3] || 0);
    return fixed[1] === '-' ? -mins : mins;
  }
  // IANA: compare wall-clock parts in tz against UTC
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: s, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at).map(p => [p.type, p.value]),
  );
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUTC - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/**
 * Fixed-offset string ("GMT+1") for a timezone at a given instant —
 * the format the scheduler tools understand.
 * @param {string} tz
 * @param {Date} [at=new Date()]
 * @returns {string}
 */
export function toGmtString(tz, at = new Date()) {
  const off = getTzOffsetMinutes(tz, at);
  const sign = off < 0 ? '-' : '+';
  const h = Math.floor(Math.abs(off) / 60);
  const m = Math.abs(off) % 60;
  return `GMT${sign}${h}${m ? ':' + String(m).padStart(2, '0') : ''}`;
}

let cachedUserTz = null;
/**
 * The user's configured timezone (config.user.timezone), cached.
 * @returns {string}
 */
export function getUserTimezone() {
  if (cachedUserTz) return cachedUserTz;
  return 'UTC';
}
/** @param {string} tz */
export function setUserTimezone(tz) {
  cachedUserTz = tz || null;
}

// ─── Display helpers ─────────────────────────────────────────────────────────
// Storage is always UTC. Convert to the user's zone only when showing a time.

/**
 * UTC "HH:mm[:ss]" on a given UTC date -> local "HH:mm" in the user's zone.
 * @param {string} utcTime - e.g. "07:15"
 * @param {string} [dateStr] - UTC date YYYY-MM-DD the time belongs to (default today)
 * @param {string} [tz]
 * @returns {string}
 */
export function utcTimeToLocal(utcTime, dateStr = new Date().toISOString().slice(0, 10), tz = getUserTimezone()) {
  const [h, m] = String(utcTime).split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return String(utcTime);
  const instant = new Date(`${dateStr}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
  return formatLocal(instant, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }, tz);
}

/**
 * Format an instant in the user's zone.
 * @param {Date|string|number} date
 * @param {Intl.DateTimeFormatOptions} [opts] - default: date + time
 * @param {string} [tz]
 * @returns {string}
 */
export function formatLocal(date, opts, tz = getUserTimezone()) {
  const d = date instanceof Date ? date : new Date(date);
  const zone = /^(GMT|UTC)/i.test(tz) ? 'UTC' : tz; // fixed offsets: Intl can't take "GMT+2"
  const shifted = zone === 'UTC' ? new Date(d.getTime() + getTzOffsetMinutes(tz, d) * 60000) : d;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    ...(opts || { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
  }).format(shifted);
}

/**
 * Local calendar date (YYYY-MM-DD) of an instant in the user's zone.
 * @param {Date} [date=new Date()]
 * @param {string} [tz]
 * @returns {string}
 */
export function localDateStr(date = new Date(), tz = getUserTimezone()) {
  const zone = /^(GMT|UTC)/i.test(tz) ? 'UTC' : tz;
  const shifted = zone === 'UTC' ? new Date(date.getTime() + getTzOffsetMinutes(tz, date) * 60000) : date;
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(shifted);
}

/**
 * Local wall-clock (date + "HH:mm") in the user's zone -> UTC instant.
 * Storage is UTC; use this when the user (or an email) gives a local time.
 * @param {string} dateStr - YYYY-MM-DD (local)
 * @param {string} hhmm - "HH:mm" (local)
 * @param {string} [tz]
 * @returns {Date}
 */
export function localToUtc(dateStr, hhmm, tz = getUserTimezone()) {
  const [h, m] = hhmm.split(':').map(Number);
  const asIfUtc = Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10), h, m);
  const offset = getTzOffsetMinutes(tz, new Date(asIfUtc));
  return new Date(asIfUtc - offset * 60000);
}
