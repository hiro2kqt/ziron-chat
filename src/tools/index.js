/**
 * Tools Registry
 * Combines all tool definitions for LLM integration
 */

import { getSchedulerTools } from './scheduler.js';
import { getWeatherTools } from './weather.js';

/**
 * Get all available tools for LLM
 * @returns {Array} Combined tool definitions
 */
export function getAllTools() {
  return [
    ...getSchedulerTools(),
    ...getWeatherTools(),
  ];
}

/**
 * Get tool definitions by category
 * @param {string} category - Tool category ('scheduler', 'weather', 'all')
 * @returns {Array} Tool definitions
 */
export function getToolsByCategory(category) {
  switch (category) {
    case 'scheduler':
      return getSchedulerTools();
    case 'weather':
      return getWeatherTools();
    case 'all':
    default:
      return getAllTools();
  }
}

export default {
  getAllTools,
  getToolsByCategory,
  getSchedulerTools,
  getWeatherTools,
};
