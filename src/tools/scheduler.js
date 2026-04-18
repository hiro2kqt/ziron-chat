/**
 * Scheduler Tool Definitions
 * Claude API tool schemas for scheduler functions
 */

/**
 * Get scheduler tool definitions for Claude API
 * @returns {Array} Tool definitions
 */
export function getSchedulerTools() {
  return [
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
                    description: 'Array of inline button rows (e.g. [[{text: "✅ Xong", callback_data: "done"}]])',
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
            description: 'Array of inline button rows (e.g. [[{text: "✅ Xong", callback_data: "done"}]])',
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
              description: 'Array of inline button rows (e.g. [[{text: "✅ Xong", callback_data: "done"}], [{text: "❌ Bỏ", callback_data: "cancel"}]])',
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    text: { type: 'string' },
                    callback_data: { type: 'string' }
                  }
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

export default { getSchedulerTools };
