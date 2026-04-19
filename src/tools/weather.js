/**
 * Weather Tool Definition
 * LLM tool schema for weather queries
 */

import { getWeather, formatWeather } from './providers/weather/index.js';

/**
 * Get weather tool definitions for LLM
 * @returns {Array} Tool definitions (Gemini-compatible)
 */
export function getWeatherTools() {
  return [
    {
      name: 'get_weather',
      description: 'Lấy thông tin thời tiết hiện tại tại một địa điểm. Returns weather data including temperature, humidity, wind, and conditions.',
      input_schema: {
        type: 'object',
        properties: {
          city: {
            type: 'string',
            description: 'Tên thành phố hoặc địa điểm cần tra thời tiết (e.g., "Dortmund", "Berlin", "Hanoi")',
          },
        },
        required: ['city'],
      },
    },
  ];
}

/**
 * Execute weather tool call
 * @param {string} tool - Tool name
 * @param {Object} args - Tool arguments
 * @returns {Promise<string>} Formatted weather result
 */
export async function executeWeatherTool(tool, args) {
  if (tool === 'get_weather') {
    const result = await getWeather(args);
    return formatWeather(result);
  }
  throw new Error(`Unknown weather tool: ${tool}`);
}

export default {
  getWeatherTools,
  executeWeatherTool,
  getWeather,
  formatWeather,
};
