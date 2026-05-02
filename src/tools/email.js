/**
 * Email Tool Definition
 * LLM tool schema for email checking and querying
 */

import { checkNewEmails, formatEmailNotification } from './providers/email/index.js';
import { queryEmails, formatQueryResults } from './providers/email/query.js';

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
    {
      name: 'query_emails',
      description: 'Search through stored important emails by date range and topic. Use this when user asks about past emails, deadlines, assignments, exams, or announcements.',
      input_schema: {
        type: 'object',
        properties: {
          days: {
            type: 'number',
            description: 'Number of days to look back (e.g., 7 for last week, 30 for last month). Default is 7 days.',
          },
          startDate: {
            type: 'string',
            description: 'Start date for explicit date range (ISO format: YYYY-MM-DD)',
          },
          endDate: {
            type: 'string',
            description: 'End date for explicit date range (ISO format: YYYY-MM-DD)',
          },
          topic: {
            type: 'string',
            description: 'Topic filter keyword: "assignments", "exams", "deadlines", "announcements", or any keyword to search in subject/content',
          },
        },
        required: [],
      },
    },
  ];
}

export default {
  getEmailTools,
  checkNewEmails,
  formatEmailNotification,
  queryEmails,
  formatQueryResults,
};
