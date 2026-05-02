/**
 * Email Query Provider
 * Query stored emails from MongoDB
 */

import Email from '../../../db/models/Email.js';
import { getDateRange, parseISODate, getStartOfDay, getEndOfDay } from '../../../utils/time.js';
import logger from '../../../utils/logger.js';

/**
 * Query emails from MongoDB
 * @param {Object} params - Query parameters
 * @param {number} [params.days] - Number of days to look back
 * @param {string} [params.startDate] - Start date (ISO string)
 * @param {string} [params.endDate] - End date (ISO string)
 * @param {string} [params.topic] - Topic filter (assignments, exams, deadlines, etc.)
 * @returns {Promise<Array>} Matched emails
 */
export async function queryEmails(params = {}) {
  const { days, startDate, endDate, topic } = params;

  logger.debug('[Email Query] Query params:', params);

  // Build date range filter
  let dateFilter = {};

  if (startDate && endDate) {
    // Explicit date range
    dateFilter = {
      date: {
        $gte: getStartOfDay(parseISODate(startDate)),
        $lte: getEndOfDay(parseISODate(endDate)),
      },
    };
  } else if (days !== undefined) {
    // Last N days
    const { start, end } = getDateRange(days);
    dateFilter = {
      date: {
        $gte: start,
        $lte: end,
      },
    };
  } else {
    // Default: last 7 days
    const { start, end } = getDateRange(7);
    dateFilter = {
      date: {
        $gte: start,
        $lte: end,
      },
    };
  }

  // Build query
  const query = {
    ...dateFilter,
    important: true, // Only query important emails
  };

  // Add topic filter if provided
  if (topic) {
    const topicLower = topic.toLowerCase();

    // Try to match category first
    const categoryMatch = {
      'assignment': 'assignment',
      'assignments': 'assignment',
      'homework': 'assignment',
      'exam': 'exam',
      'exams': 'exam',
      'test': 'exam',
      'deadline': 'deadline',
      'deadlines': 'deadline',
      'due': 'deadline',
      'announcement': 'announcement',
      'announcements': 'announcement',
      'news': 'announcement',
    };

    const category = categoryMatch[topicLower];

    if (category) {
      query.category = category;
    } else {
      // Use regex search on subject, summary, and category
      const topicRegex = new RegExp(topic, 'i');
      query.$or = [
        { subject: topicRegex },
        { summary: topicRegex },
        { snippet: topicRegex },
      ];
    }
  }

  try {
    const emails = await Email.find(query)
      .sort({ date: -1 }) // Most recent first
      .limit(50) // Limit to 50 results
      .lean();

    logger.info(`[Email Query] Found ${emails.length} email(s)`);

    return emails;

  } catch (err) {
    logger.error('[Email Query] Error querying emails:', err.message);
    throw err;
  }
}

/**
 * Format query results for LLM
 * @param {Array} emails - Query results
 * @returns {string} Formatted text
 */
export function formatQueryResults(emails) {
  if (emails.length === 0) {
    return 'No emails found matching the criteria.';
  }

  let result = `Found ${emails.length} email(s):\n\n`;

  emails.forEach((email, i) => {
    const dateStr = new Date(email.date).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

    result += `${i + 1}. [${email.category.toUpperCase()}] ${email.subject}\n`;
    result += `   From: ${email.from}\n`;
    result += `   Date: ${dateStr}\n`;

    if (email.summary) {
      result += `   Summary: ${email.summary}\n`;
    } else if (email.snippet) {
      const preview = email.snippet.length > 100
        ? email.snippet.slice(0, 100) + '...'
        : email.snippet;
      result += `   Preview: ${preview}\n`;
    }

    result += '\n';
  });

  return result;
}

export default {
  queryEmails,
  formatQueryResults,
};
