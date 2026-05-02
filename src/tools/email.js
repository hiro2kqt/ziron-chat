/**
 * Email Tool Definition
 * LLM tool schema for email checking (optional - mainly for manual triggers)
 */

import { checkNewEmails, formatEmailNotification } from './providers/email/index.js';

/**
 * Get email tool definitions for LLM
 * @returns {Array} Tool definitions
 */
export function getEmailTools() {
  return [
    {
      name: 'check_emails',
      description: 'Check for new important university emails (deadlines, exams, assignments, announcements)',
      input_schema: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  ];
}

export default {
  getEmailTools,
  checkNewEmails,
  formatEmailNotification,
};
