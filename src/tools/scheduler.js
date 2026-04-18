/**
 * Scheduler Tool Definitions
 * Claude API tool schemas for scheduler functions
 */

/**
 * Calculate time for scheduling based on expression and timezone
 * @param {Object} params - Parameters
 * @param {string} params.expression - Time expression (e.g., "now + 20m", "today 15:00", "tomorrow 08:00")
 * @param {string} params.timezone - Timezone string (e.g., "GMT+2", "GMT-5", "UTC")
 * @returns {Object} Calculated times in UTC and local timezone
 */
export function calculateTime({ expression, timezone }) {
  // Parse timezone offset from string
  function parseTimezoneOffset(tz) {
    const upperTz = tz.toUpperCase().trim();

    // Handle UTC
    if (upperTz === 'UTC' || upperTz === 'GMT' || upperTz === 'GMT+0' || upperTz === 'GMT-0') {
      return 0;
    }

    // Handle GMT+N or GMT-N
    const gmtMatch = upperTz.match(/GMT([+-])(\d+)/);
    if (gmtMatch) {
      const sign = gmtMatch[1] === '+' ? 1 : -1;
      const hours = parseInt(gmtMatch[2], 10);
      return sign * hours;
    }

    throw new Error(`Unsupported timezone format: ${tz}. Use format like "GMT+2", "GMT-5", or "UTC"`);
  }

  // Parse time string (HH:MM) and return {hours, minutes}
  function parseTime(timeStr) {
    const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
      throw new Error(`Invalid time format: ${timeStr}. Use HH:MM format`);
    }
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      throw new Error(`Invalid time values: ${timeStr}`);
    }
    return { hours, minutes };
  }

  // Format date as YYYY-MM-DD
  function formatDate(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // Format time as HH:MM
  function formatTime(date) {
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  // Get timezone offset in hours
  const tzOffset = parseTimezoneOffset(timezone);

  // Get current UTC time
  const nowUTC = new Date();

  // Parse expression and calculate target UTC time
  const expr = expression.trim().toLowerCase();
  let targetUTC;

  if (expr.startsWith('now + ')) {
    // Handle "now + Xm", "now + Xh", "now + XhYm", "now + Xd"
    const deltaStr = expr.substring(6); // Remove "now + "

    targetUTC = new Date(nowUTC);

    // Parse complex format like "1h30m"
    const hourMatch = deltaStr.match(/(\d+)h/);
    const minuteMatch = deltaStr.match(/(\d+)m/);
    const dayMatch = deltaStr.match(/(\d+)d/);

    if (dayMatch) {
      const days = parseInt(dayMatch[1], 10);
      targetUTC.setUTCDate(targetUTC.getUTCDate() + days);
    }
    if (hourMatch) {
      const hours = parseInt(hourMatch[1], 10);
      targetUTC.setUTCHours(targetUTC.getUTCHours() + hours);
    }
    if (minuteMatch) {
      const minutes = parseInt(minuteMatch[1], 10);
      targetUTC.setUTCMinutes(targetUTC.getUTCMinutes() + minutes);
    }

    // Check if we parsed anything
    if (!hourMatch && !minuteMatch && !dayMatch) {
      throw new Error(`Invalid time delta format: ${deltaStr}. Use formats like "20m", "2h", "1h30m", "1d"`);
    }
  } else if (expr.startsWith('today ')) {
    // Handle "today HH:MM" - specific time today in local timezone
    const timeStr = expr.substring(6); // Remove "today "
    const { hours, minutes } = parseTime(timeStr);

    // Create date in local timezone
    targetUTC = new Date(nowUTC);
    targetUTC.setUTCHours(hours - tzOffset, minutes, 0, 0);

  } else if (expr.startsWith('tomorrow ')) {
    // Handle "tomorrow HH:MM" - specific time tomorrow in local timezone
    const timeStr = expr.substring(9); // Remove "tomorrow "
    const { hours, minutes } = parseTime(timeStr);

    // Create date in local timezone, add 1 day
    targetUTC = new Date(nowUTC);
    targetUTC.setUTCDate(targetUTC.getUTCDate() + 1);
    targetUTC.setUTCHours(hours - tzOffset, minutes, 0, 0);

  } else {
    throw new Error(`Unsupported expression format: ${expression}. Use formats like "now + 20m", "today 15:00", "tomorrow 08:00"`);
  }

  // Calculate local time by applying timezone offset
  const localTime = new Date(targetUTC.getTime() + tzOffset * 60 * 60 * 1000);

  return {
    utcTime: formatTime(targetUTC),
    utcDate: formatDate(targetUTC),
    localTime: formatTime(localTime),
    localDate: formatDate(localTime),
    timezone: timezone,
    expression: expression
  };
}

/**
 * Get scheduler tool definitions for Claude API
 * @returns {Array} Tool definitions
 */
export function getSchedulerTools() {
  return [
    {
      name: 'calculateTime',
      description: 'Calculate the exact UTC time for scheduling. ALWAYS call this tool first before any scheduling tool (addOneshotJob, addOneshotInterval, addRecurringJob) to get the correct UTC time. Never calculate time yourself.',
      input_schema: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: "Time expression. Examples: 'now + 20m', 'now + 2h', 'now + 1h30m', 'today 15:00', 'tomorrow 08:00', 'now + 1d'",
          },
          timezone: {
            type: 'string',
            description: "User timezone from Environment section, e.g. 'GMT+2', 'GMT+7', 'UTC'",
          },
        },
        required: ['expression', 'timezone'],
      },
    },
    {
      name: 'addOneshotJob',
      description: 'Schedule a one-time reminder for today. Use this for single reminders like "remind me at 3pm" or "nhắc tôi lúc 15:00".',
      input_schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Job name (short identifier, e.g., "lunch-reminder")',
          },
          chatId: {
            type: 'string',
            description: 'Chat ID where reminders will be sent (CRITICAL: MUST use the exact chatId provided in your context/instructions. DO NOT use words like "default", "user", etc.)',
          },
          refId: {
            type: 'string',
            description: 'Unique string used to group related jobs',
          },
          fireAt: {
            type: 'string',
            description: "Time in HH:MM format (CRITICAL: MUST BE IN UTC! Do NOT pass the user's local time)",
          },
                  message: {
                    type: 'string',
                    description: 'Message text to send',
                  },
                  buttons: {
                    type: 'array',
                    description: 'Telegram inline keyboard rows',
                    items: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          text: { type: 'string', description: 'Button label' },
                          callback_data: { type: 'string', description: 'Callback data' }
                        },
                        required: ['text', 'callback_data']
                      }
                    }
                  }
                },
        required: ['name', 'chatId', 'fireAt', 'message'],
      },
    },
    {
      name: 'addOneshotInterval',
      description: 'Schedule multiple reminders at regular intervals for today. Use this for requests like "every 10 minutes for 2 hours" or "mỗi 10 phút trong 2 giờ tới".',
      input_schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Job name (short identifier)',
          },
          chatId: {
            type: 'string',
            description: 'Chat ID where reminders will be sent',
          },
          refId: {
            type: 'string',
            description: 'Unique string used to group related jobs',
          },
          fromTime: {
            type: 'string',
            description: "Start time in HH:MM format (CRITICAL: MUST BE IN UTC! Do NOT pass the user's local time)",
          },
          toTime: {
            type: 'string',
            description: "End time in HH:MM format (CRITICAL: MUST BE IN UTC! Do NOT pass the user's local time)",
          },
            intervalMinutes: {
            type: 'number',
            description: 'Interval in minutes between reminders (can use decimals for seconds, e.g. 0.167 for 10s, 0.5 for 30s)',
          },
          message: {
            type: 'string',
            description: 'Message text to send',
          },
          buttons: {
            type: 'array',
            description: 'Telegram inline keyboard rows',
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'Button label' },
                  callback_data: { type: 'string', description: 'Callback data' }
                },
                required: ['text', 'callback_data']
              }
            },
          },
        },
        required: ['name', 'chatId', 'fromTime', 'toTime', 'intervalMinutes', 'message'],
      },
    },
    {
      name: 'addRecurringJob',
      description: 'Schedule a recurring reminder (daily or specific days of week). Use this for requests like "remind me every day at 9am" or "every Monday and Friday at 10:00".',
      input_schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Job name (short identifier)',
          },
          chatId: {
            type: 'string',
            description: 'Chat ID where reminders will be sent',
          },
          refId: {
            type: 'string',
            description: 'Unique string used to group related jobs',
          },
          repeatDays: {
            type: 'array',
            items: {
              type: 'number',
            },
            description: 'Days of week (0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday). Empty array means every day.',
          },
          timeTriggers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
              time: {
                type: 'string',
                description: "Time in HH:MM format (CRITICAL: MUST BE IN UTC! Do NOT pass the user's local time)",
              },
            message: {
              type: 'string',
              description: 'Message text to send',
            },
            buttons: {
              type: 'array',
              description: 'Telegram inline keyboard rows',
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    text: { type: 'string', description: 'Button label' },
                    callback_data: { type: 'string', description: 'Callback data' }
                  },
                  required: ['text', 'callback_data']
                }
              }
            }
          },
              required: ['time', 'message'],
            },
            description: 'Array of time triggers with messages',
          },
        },
        required: ['name', 'chatId', 'repeatDays', 'timeTriggers'],
      },
    },
    {
      name: 'listTodayJobs',
      description: 'List all pending reminders scheduled for today',
      input_schema: {
        type: 'object',
        properties: {
          chatId: {
            type: 'string',
            description: "Chat ID to list jobs for (must match the user's actual chat ID)",
          },
        },
        required: ['chatId'],
      },
    },
    {
      name: 'disableJobsByName',
      description: 'Cancel/disable all reminders with a specific name for today. CRITICAL: NEVER GUESS the name. ALWAYS call listTodayJobs first to get the EXACT name from the database.',
      input_schema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Job name to disable',
          },
          dateStr: {
            type: 'string',
            description: 'Date in YYYY-MM-DD format (CRITICAL: MUST use the exact ISO date format, e.g., "2026-04-18". Do NOT use words like "today" or "tomorrow").',
          },
        },
        required: ['name', 'dateStr'],
      },
    },
  ];
}

export default { getSchedulerTools, calculateTime };
