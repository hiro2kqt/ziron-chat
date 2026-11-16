/**
 * Email Tool - Main Entry Point
 */

import { hasUpcomingDeadline, formatLocalDay } from './reminders.js';
import { checkNewEmails as checkNewEmailsImpl } from './monitor.js';
import { classifyEmail as classifyEmailImpl } from './classifier.js';
import { queryEmails as queryEmailsImpl, formatQueryResults as formatQueryResultsImpl } from './query.js';

// Re-export for named imports
export { checkNewEmails } from './monitor.js';
export { classifyEmail } from './classifier.js';
export { queryEmails, formatQueryResults } from './query.js';

/**
 * Format important emails for notification
 * @param {Array} emails - Array of important emails with classification
 * @returns {string} Formatted message
 */
/**
 * Escape text for Telegram legacy Markdown (parse_mode: 'Markdown'):
 * only _ * ` [ are special there.
 * @param {string} text
 * @returns {string}
 */
export function escapeMarkdown(text) {
  return String(text ?? '').replace(/([_*`\[])/g, '\\$1');
}

export function formatEmailNotification(emails) {
  if (emails.length === 0) {
    return '';
  }

  const icon = {
    registration: '📝', exam: '🎓', assignment: '📚', deadline: '⏰',
    course: '📖', announcement: '📢', other: '✉️',
  };
  let message = `🔔 *${emails.length} new important email${emails.length > 1 ? 's' : ''}*\n`;

  // Subjects/summaries are untrusted text ("lsf-ASL-26_1"): escape them so a
  // stray _ or * can't break the Markdown message
  const numbered = emails.length > 1;
  emails.forEach((email, i) => {
    const c = email.classification;
    const n = numbered ? `${i + 1}. ` : '';
    message += `\n${n}${icon[c.category] || '✉️'} *${escapeMarkdown(email.subject)}*\n${escapeMarkdown(c.summary || c.reason)}\n`;
    if (c.deadline && hasUpcomingDeadline(c.deadline)) {
      message += `⏳ Hạn: ${formatLocalDay(c.deadline.slice(0, 10), c.deadline.slice(11, 16) || '')}\n`;
    }
  });

  return message;
}

/**
 * Inline buttons for an email notification: one row per email with
 * "show full mail" and, if it has an upcoming deadline, "remind me before".
 * @param {Array} emails - important emails ({ uid, classification })
 * @returns {{inline_keyboard: Array}|undefined}
 */
export function buildEmailKeyboard(emails) {
  if (!emails?.length) return undefined;
  const numbered = emails.length > 1;
  const rows = emails.map((email, i) => {
    const n = numbered ? ` #${i + 1}` : '';
    const row = [{ text: `📄 Xem full${n}`, callback_data: `!act:mail:${email.uid}` }];
    if (hasUpcomingDeadline(email.classification?.deadline)) {
      row.push({ text: `⏰ Nhắc trước hạn${n}`, callback_data: `!act:mremind:${email.uid}` });
    }
    return row;
  });
  return { inline_keyboard: rows };
}

export default {
  checkNewEmails: checkNewEmailsImpl,
  classifyEmail: classifyEmailImpl,
  queryEmails: queryEmailsImpl,
  formatEmailNotification,
  formatQueryResults: formatQueryResultsImpl,
};
