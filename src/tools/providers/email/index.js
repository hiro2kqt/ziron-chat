/**
 * Email Tool - Main Entry Point
 */

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
export function formatEmailNotification(emails) {
  if (emails.length === 0) {
    return '';
  }

  let message = `🔔 *${emails.length} new important email${emails.length > 1 ? 's' : ''}*\n`;

  emails.forEach(email => {
    message += `- ${email.classification.reason}\n`;
  });

  return message;
}

export default {
  checkNewEmails: checkNewEmailsImpl,
  classifyEmail: classifyEmailImpl,
  queryEmails: queryEmailsImpl,
  formatEmailNotification,
  formatQueryResults: formatQueryResultsImpl,
};
