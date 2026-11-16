/**
 * Deadline reminders for emails — pure planning helpers (no I/O).
 * Deadlines come from the classifier as local "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM".
 */

import { localToUtc, localDateStr } from '../../../utils/time.js';

const VI_WEEKDAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "T3 20/01" (+ " 14:00" when a time is given) */
export function formatLocalDay(dateStr, time) {
  const wd = VI_WEEKDAYS[new Date(`${dateStr}T12:00:00Z`).getUTCDay()];
  return `${wd} ${dateStr.slice(8, 10)}/${dateStr.slice(5, 7)}${time ? ` ${time}` : ''}`;
}

/**
 * @param {string|null} deadline
 * @param {Date} [now]
 * @returns {boolean} true if the deadline is today or later (local)
 */
export function hasUpcomingDeadline(deadline, now = new Date()) {
  if (!deadline || !/^\d{4}-\d{2}-\d{2}/.test(deadline)) return false;
  const day = deadline.slice(0, 10);
  const time = deadline.slice(11, 16);
  if (time) return localToUtc(day, time) > now;
  return day >= localDateStr(now);
}

/**
 * Reminder slots before a deadline: 3 days before and 1 day before at 09:00,
 * and on the day itself at 08:00 (or 2h before a given time, not before 07:00).
 * Only slots still in the future are returned.
 * @param {string} deadline
 * @param {Date} [now]
 * @returns {Array<{date: string, time: string, label: string, utc: Date}>} local date/time + UTC instant
 */
export function planDeadlineReminders(deadline, now = new Date()) {
  if (!hasUpcomingDeadline(deadline, now)) return [];
  const day = deadline.slice(0, 10);
  const time = deadline.slice(11, 16) || null;

  let dayOfTime = '08:00';
  if (time) {
    const mins = Math.max(7 * 60, Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) - 120);
    dayOfTime = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }

  const slots = [
    { date: addDays(day, -3), time: '09:00', label: 'Deadline in 3 days' },
    { date: addDays(day, -1), time: '09:00', label: 'Deadline tomorrow' },
    { date: day, time: dayOfTime, label: time ? `Deadline today at ${time}` : 'Deadline today' },
  ];
  return slots
    .map(s => ({ ...s, utc: localToUtc(s.date, s.time) }))
    .filter(s => s.utc.getTime() > now.getTime() + 60000);
}
