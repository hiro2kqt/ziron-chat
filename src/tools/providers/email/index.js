/**
 * Email Tool - Main Entry Point
 */

export { checkNewEmails } from './monitor.js';
export { classifyEmail } from './classifier.js';

/**
 * Format important emails for notification
 * @param {Array} emails - Array of important emails with classification
 * @returns {string} Formatted message
 */
export function formatEmailNotification(emails) {
  if (emails.length === 0) {
    return '';
  }

  const categoryEmojis = {
    deadline: '⏰',
    exam: '📝',
    assignment: '📚',
    announcement: '📢',
    other: '📧',
  };

  let message = `🔔 *${emails.length} Important Email${emails.length > 1 ? 's' : ''}*\n\n`;

  emails.forEach((email, i) => {
    const emoji = categoryEmojis[email.classification.category] || '📧';
    message += `${emoji} *${email.subject}*\n`;
    message += `👤 From: ${email.from}\n`;
    message += `📂 Category: ${email.classification.category}\n`;
    message += `💡 Why: ${email.classification.reason}\n`;

    if (email.snippet && email.snippet.length > 0) {
      const preview = email.snippet.length > 150
        ? email.snippet.slice(0, 150) + '...'
        : email.snippet;
      message += `📄 Preview: ${preview}\n`;
    }

    if (i < emails.length - 1) {
      message += '\n---\n\n';
    }
  });

  return message;
}

export default {
  checkNewEmails,
  classifyEmail,
  formatEmailNotification,
};
