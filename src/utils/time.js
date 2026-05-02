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
