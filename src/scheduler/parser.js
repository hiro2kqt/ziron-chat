/**
 * Scheduler Parser
 * Builds compiled jobs with pre-generated buttons
 */

/**
 * Build a recurring job with compiled buttons
 * @param {Object} params - Job parameters
 * @param {string} params.name - Job name
 * @param {string} params.chatId - Chat ID
 * @param {Array<number>} params.repeatDays - Days of week (0=Sun, 1=Mon, etc). Empty = every day
 * @param {Array<Object>} params.triggers - Time triggers
 * @returns {Object} Compiled job object
 */
export function buildRecurringJob({ name, chatId, repeatDays = [], triggers }) {
  // Compile triggers with buttons
  const timeTriggers = triggers.map(trigger => {
    const buttons = [
      [
        { text: '✅ Đã xong', callback_data: `done:${name}` },
        { text: '⏰ 15p', callback_data: `snooze:15:{todayJobId}` },
        { text: '⏰ 30p', callback_data: `snooze:30:{todayJobId}` },
        { text: '❌ Bỏ hôm nay', callback_data: `skip_today:{todayJobId}` },
      ],
    ];

    return {
      time: trigger.time,
      message: trigger.message,
      buttons,
    };
  });

  return {
    name,
    chat_id: chatId,
    repeat_days: repeatDays,
    time_triggers: timeTriggers,
    enabled: true,
  };
}

/**
 * Build a oneshot job with compiled buttons
 * @param {Object} params - Job parameters
 * @param {string} params.name - Job name
 * @param {string} params.chatId - Chat ID
 * @param {string} params.fireAt - Fire time in HH:MM format
 * @param {string} params.message - Message text
 * @returns {Object} Compiled today_job object
 */
export function buildOneshotJob({ name, chatId, fireAt, message }) {
  const today = new Date().toISOString().split('T')[0];

  const buttons = [
    [
      { text: '✅ Done', callback_data: `done:${name}` },
      { text: '⏰ Snooze 15p', callback_data: `snooze:15:{todayJobId}` },
      { text: '⏰ Snooze 30p', callback_data: `snooze:30:{todayJobId}` },
    ],
  ];

  return {
    name,
    chat_id: chatId,
    fire_at: fireAt,
    message,
    buttons,
    source: 'oneshot',
    date: today,
    enabled: true,
    fired: false,
  };
}

/**
 * Build oneshot interval parameters
 * @param {Object} params - Interval parameters
 * @param {string} params.name - Job name
 * @param {string} params.chatId - Chat ID
 * @param {string} params.fromTime - Start time HH:MM
 * @param {string} params.toTime - End time HH:MM
 * @param {number} params.intervalMinutes - Interval in minutes
 * @param {string} params.message - Message text
 * @returns {Object} Parameters for insertOneShotJobs()
 */
export function buildOneshotInterval({ name, chatId, fromTime, toTime, intervalMinutes, message }) {
  const buttons = [
    [
      { text: '✅ Done', callback_data: `done:${name}` },
      { text: '⏰ Snooze 15p', callback_data: `snooze:15:{todayJobId}` },
      { text: '⏰ Snooze 30p', callback_data: `snooze:30:{todayJobId}` },
    ],
  ];

  return {
    name,
    chatId,
    fromTime,
    toTime,
    intervalMinutes,
    message,
    buttons,
  };
}

export default {
  buildRecurringJob,
  buildOneshotJob,
  buildOneshotInterval,
};
