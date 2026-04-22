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
 * Expand a time range into array of UTC times at regular intervals
 * @param {Object} params
 * @param {string} params.fromLocal - Start time in local timezone "HH:MM"
 * @param {string} params.toLocal - End time in local timezone "HH:MM"
 * @param {number} params.intervalMinutes - Interval in minutes (can be decimal, e.g. 0.333 for 20s)
 * @param {string} params.timezone - e.g. "GMT+2"
 * @returns {{ utcTimes: string[], localTimes: string[], count: number }}
 */
export function calculateTimeRange({ fromLocal, toLocal, intervalMinutes, timezone }) {
  // Parse timezone offset from string
  function parseTimezoneOffset(tz) {
    const upperTz = tz.toUpperCase().trim();
    if (upperTz === 'UTC' || upperTz === 'GMT' || upperTz === 'GMT+0' || upperTz === 'GMT-0') {
      return 0;
    }
    const gmtMatch = upperTz.match(/GMT([+-])(\d+)/);
    if (gmtMatch) {
      const sign = gmtMatch[1] === '+' ? 1 : -1;
      const hours = parseInt(gmtMatch[2], 10);
      return sign * hours;
    }
    throw new Error(`Unsupported timezone format: ${tz}. Use format like "GMT+2", "GMT-5", or "UTC"`);
  }

  // Parse time string (HH:MM) and return total minutes since midnight
  function parseTimeToMinutes(timeStr) {
    const match = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (!match) {
      throw new Error(`Invalid time format: ${timeStr}. Use HH:MM format`);
    }
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      throw new Error(`Invalid time values: ${timeStr}`);
    }
    return hours * 60 + minutes;
  }

  // Format minutes to HH:MM
  function formatMinutes(totalMinutes) {
    const normalizedMinutes = ((totalMinutes % 1440) + 1440) % 1440; // Wrap to 0-1439
    const hours = Math.floor(normalizedMinutes / 60);
    const minutes = Math.floor(normalizedMinutes % 60);
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  }

  const tzOffset = parseTimezoneOffset(timezone);
  const offsetMinutes = tzOffset * 60;

  // Convert local times to UTC minutes
  const fromLocalMinutes = parseTimeToMinutes(fromLocal);
  const toLocalMinutes = parseTimeToMinutes(toLocal);
  const fromUTCMinutes = fromLocalMinutes - offsetMinutes;
  const toUTCMinutes = toLocalMinutes - offsetMinutes;

  // Generate time array
  const utcTimes = [];
  const localTimes = [];
  let currentMinutes = fromUTCMinutes;

  while (currentMinutes <= toUTCMinutes) {
    utcTimes.push(formatMinutes(currentMinutes));
    localTimes.push(formatMinutes(currentMinutes + offsetMinutes));
    currentMinutes += intervalMinutes;
  }

  return {
    utcTimes,
    localTimes,
    count: utcTimes.length,
    fromUTC: formatMinutes(fromUTCMinutes),
    toUTC: formatMinutes(toUTCMinutes),
    timezone
  };
}

/**
 * Parse day expression into array of day numbers (0=Sunday, 6=Saturday)
 * @param {Object} params
 * @param {string} params.expression - Day expression in Vietnamese or English
 * @returns {{ days: number[], description: string }}
 */
export function calculateRecurringDays({ expression }) {
  const expr = expression.toLowerCase().trim();

  // Day mappings
  const dayMap = {
    // Vietnamese
    'thứ 2': 1, 'thứ hai': 1, 'monday': 1, 'mon': 1,
    'thứ 3': 2, 'thứ ba': 2, 'tuesday': 2, 'tue': 2,
    'thứ 4': 3, 'thứ tư': 3, 'wednesday': 3, 'wed': 3,
    'thứ 5': 4, 'thứ năm': 4, 'thursday': 4, 'thu': 4,
    'thứ 6': 5, 'thứ sáu': 5, 'friday': 5, 'fri': 5,
    'thứ 7': 6, 'thứ bảy': 6, 'saturday': 6, 'sat': 6,
    'chủ nhật': 0, 'sunday': 0, 'sun': 0,
    // Shortcuts
    '2': 1, '3': 2, '4': 3, '5': 4, '6': 5, '7': 6
  };

  const dayNames = [
    'Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'
  ];

  // Handle special cases
  if (expr === 'mỗi ngày' || expr === 'hàng ngày' || expr === 'every day' || expr === 'everyday') {
    return { days: [], description: 'Mỗi ngày' };
  }
  if (expr === 'ngày trong tuần' || expr === 'weekdays') {
    return { days: [1, 2, 3, 4, 5], description: 'Ngày trong tuần (Thứ 2-6)' };
  }
  if (expr === 'cuối tuần' || expr === 'weekend') {
    return { days: [0, 6], description: 'Cuối tuần (Thứ 7, Chủ nhật)' };
  }

  // Handle ranges: "thứ 2 đến thứ 6" or "monday to friday"
  const rangeMatch = expr.match(/(thứ \d+|thứ [a-záàảãạăắằẳẵặâấầẩẫậđéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵ]+|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d)\s*(đến|to|-)\s*(thứ \d+|thứ [a-záàảãạăắằẳẵặâấầẩẫậđéèẻẽẹêếềểễệíìỉĩịóòỏõọôốồổỗộơớờởỡợúùủũụưứừửữựýỳỷỹỵ]+|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d)/);
  if (rangeMatch) {
    const fromDay = dayMap[rangeMatch[1].trim()];
    const toDay = dayMap[rangeMatch[3].trim()];
    if (fromDay !== undefined && toDay !== undefined) {
      const days = [];
      for (let d = fromDay; d <= toDay; d++) {
        days.push(d);
      }
      return {
        days: [...new Set(days)].sort((a, b) => a - b),
        description: days.map(d => dayNames[d]).join(', ')
      };
    }
  }

  // Handle comma/and separated: "thứ 2, 4, 6" or "monday and friday"
  const separators = /[,và]+|and/g;
  const parts = expr.split(separators).map(p => p.trim());

  const days = new Set();
  for (const part of parts) {
    const day = dayMap[part];
    if (day !== undefined) {
      days.add(day);
    }
  }

  if (days.size === 0) {
    throw new Error(`Cannot parse day expression: ${expression}. Use formats like "thứ 2", "thứ 2, 4, 6", "weekdays", "every day"`);
  }

  const sortedDays = [...days].sort((a, b) => a - b);
  return {
    days: sortedDays,
    description: sortedDays.map(d => dayNames[d]).join(', ')
  };
}

/**
 * Calculate end time from a start expression and duration
 * @param {Object} params
 * @param {string} params.startExpression - "now", "today HH:MM", "tomorrow HH:MM", or "now + Xm/Xh"
 * @param {string} params.duration - Duration string: "2h", "30m", "1h30m", "2h30m"
 * @param {string} params.timezone - e.g. "GMT+2"
 * @returns {{ fromUTC, toUTC, fromLocal, toLocal, fromDate, toDate, timezone }}
 */
export function calculateEndTime({ startExpression, duration, timezone }) {
  // Handle "now" as a special case (convert to "now + 0m" for calculateTime)
  const normalizedExpression = startExpression.trim().toLowerCase() === 'now'
    ? 'now + 0m'
    : startExpression;

  // Use existing calculateTime to get start time
  const startTime = calculateTime({ expression: normalizedExpression, timezone });

  // Parse duration string
  const durationStr = duration.toLowerCase().trim();
  const hourMatch = durationStr.match(/(\d+)h/);
  const minuteMatch = durationStr.match(/(\d+)m/);

  let durationMinutes = 0;
  if (hourMatch) {
    durationMinutes += parseInt(hourMatch[1], 10) * 60;
  }
  if (minuteMatch) {
    durationMinutes += parseInt(minuteMatch[1], 10);
  }

  if (durationMinutes === 0) {
    throw new Error(`Invalid duration format: ${duration}. Use formats like "2h", "30m", "1h30m"`);
  }

  // Calculate end time
  const fromUTCDate = new Date(`${startTime.utcDate}T${startTime.utcTime}:00Z`);
  const toUTCDate = new Date(fromUTCDate.getTime() + durationMinutes * 60 * 1000);

  // Format results
  function formatDate(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function formatTime(date) {
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  // Parse timezone for local time calculation
  function parseTimezoneOffset(tz) {
    const upperTz = tz.toUpperCase().trim();
    if (upperTz === 'UTC' || upperTz === 'GMT' || upperTz === 'GMT+0' || upperTz === 'GMT-0') {
      return 0;
    }
    const gmtMatch = upperTz.match(/GMT([+-])(\d+)/);
    if (gmtMatch) {
      const sign = gmtMatch[1] === '+' ? 1 : -1;
      const hours = parseInt(gmtMatch[2], 10);
      return sign * hours;
    }
    return 0;
  }

  const tzOffset = parseTimezoneOffset(timezone);
  const toLocalDate = new Date(toUTCDate.getTime() + tzOffset * 60 * 60 * 1000);

  return {
    fromUTC: startTime.utcTime,
    fromLocal: startTime.localTime,
    fromDate: startTime.utcDate,
    toUTC: formatTime(toUTCDate),
    toLocal: formatTime(toLocalDate),
    toDate: formatDate(toUTCDate),
    timezone
  };
}

/**
 * Calculate specific dates from natural language descriptions
 * @param {Object} params
 * @param {string[]} params.dates - Array of date descriptions
 * @param {string} params.timezone - Timezone offset, e.g. 'GMT+2'
 * @returns {{ dates: string[] }}
 */
export function calculateSpecificDates({ dates, timezone }) {
  // Parse timezone offset
  function parseTimezoneOffset(tz) {
    if (!tz) return 0;
    const upperTz = tz.toUpperCase().trim();
    if (upperTz === 'UTC' || upperTz === 'GMT' || upperTz === 'GMT+0' || upperTz === 'GMT-0') {
      return 0;
    }
    const gmtMatch = upperTz.match(/GMT([+-])(\d+)/);
    if (gmtMatch) {
      const sign = gmtMatch[1] === '+' ? 1 : -1;
      const hours = parseInt(gmtMatch[2], 10);
      return sign * hours;
    }
    return 0;
  }

  function formatDate(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  const tzOffset = parseTimezoneOffset(timezone);
  const nowUTC = new Date();
  
  // Current local time
  const localNow = new Date(nowUTC.getTime() + tzOffset * 60 * 60 * 1000);
  
  const resultDates = [];
  
  for (const expr of dates) {
    const d = expr.toLowerCase().trim();
    
    let targetLocal = new Date(localNow);
    
    // Check "ngày mai"
    if (d === 'ngày mai' || d === 'tomorrow') {
      targetLocal.setUTCDate(targetLocal.getUTCDate() + 1);
    }
    // Check "X ngày nữa"
    else if (d.match(/(\d+)\s*ngày nữa/)) {
      const days = parseInt(d.match(/(\d+)\s*ngày nữa/)[1], 10);
      targetLocal.setUTCDate(targetLocal.getUTCDate() + days);
    }
    // Check "ngày DD/MM/YYYY" or "DD/MM/YYYY"
    else if (d.match(/(?:ngày\s+)?(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/)) {
      const match = d.match(/(?:ngày\s+)?(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
      const day = parseInt(match[1], 10);
      const month = parseInt(match[2], 10) - 1;
      const year = parseInt(match[3], 10);
      targetLocal = new Date(Date.UTC(year, month, day));
    }
    // Check "ngày DD/MM" or "DD/MM"
    else if (d.match(/(?:ngày\s+)?(\d{1,2})[\/\-](\d{1,2})/)) {
      const match = d.match(/(?:ngày\s+)?(\d{1,2})[\/\-](\d{1,2})/);
      const day = parseInt(match[1], 10);
      const month = parseInt(match[2], 10) - 1;
      
      targetLocal.setUTCMonth(month, day);
      
      // If the calculated date is in the past (more than 1 day ago), assume next year
      if (targetLocal.getTime() < localNow.getTime() - 86400000) {
        targetLocal.setUTCFullYear(targetLocal.getUTCFullYear() + 1);
      }
    } else {
      throw new Error(`Unsupported date expression: ${d}`);
    }
    
    // We treat the calculated targetLocal date string as our UTC date string for specificDates 
    // because specific_dates are compared against UTC date.
    // Wait, the dates should be in UTC for specificDates. If it's "tomorrow" local time, 
    // we want the date string of that local time, but wait...
    // Actually, sync compares job.specific_dates against `getTodayDateStr()` which returns UTC date.
    // So specificDates must be the UTC date on which the job should run.
    // If a user in GMT+7 wants it on 26/4, that means when it's 26/4 in UTC? No, the user wants it to run when their local time is 26/4.
    // But currently the system syncs daily at UTC midnight. So `dateStr` is UTC.
    // But oneshot jobs and time calculations use UTC time for scheduling.
    // Let's just output the targetLocal date string as formatted date, which works since specific_dates is compared directly.
    resultDates.push(formatDate(targetLocal));
  }
  
  return { dates: [...new Set(resultDates)].sort() };
}

/**
 * Calculate next occurrence of a local time — today if not yet passed, tomorrow if already passed
 * @param {Object} params
 * @param {string} params.targetLocal - Target time in local timezone "HH:MM"
 * @param {string} params.timezone - e.g. "GMT+2"
 * @returns {{ utcTime, utcDate, localTime, localDate, isToday, timezone }}
 */
export function calculateNextOccurrence({ targetLocal, timezone }) {
  // Parse timezone offset
  function parseTimezoneOffset(tz) {
    const upperTz = tz.toUpperCase().trim();
    if (upperTz === 'UTC' || upperTz === 'GMT' || upperTz === 'GMT+0' || upperTz === 'GMT-0') {
      return 0;
    }
    const gmtMatch = upperTz.match(/GMT([+-])(\d+)/);
    if (gmtMatch) {
      const sign = gmtMatch[1] === '+' ? 1 : -1;
      const hours = parseInt(gmtMatch[2], 10);
      return sign * hours;
    }
    throw new Error(`Unsupported timezone format: ${tz}`);
  }

  // Parse time string
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

  // Format date and time
  function formatDate(date) {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function formatTime(date) {
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  const tzOffset = parseTimezoneOffset(timezone);
  const { hours, minutes } = parseTime(targetLocal);

  // Get current UTC time
  const nowUTC = new Date();

  // Convert target local time to UTC for today
  const targetUTCToday = new Date(nowUTC);
  targetUTCToday.setUTCHours(hours - tzOffset, minutes, 0, 0);

  // Check if target time has already passed today
  let targetUTC;
  let isToday;

  if (targetUTCToday > nowUTC) {
    // Target time is still in the future today
    targetUTC = targetUTCToday;
    isToday = true;
  } else {
    // Target time has passed, schedule for tomorrow
    targetUTC = new Date(targetUTCToday);
    targetUTC.setUTCDate(targetUTC.getUTCDate() + 1);
    isToday = false;
  }

  // Calculate local time
  const localDate = new Date(targetUTC.getTime() + tzOffset * 60 * 60 * 1000);

  return {
    utcTime: formatTime(targetUTC),
    utcDate: formatDate(targetUTC),
    localTime: formatTime(localDate),
    localDate: formatDate(localDate),
    isToday,
    timezone
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
      name: 'calculateTimeRange',
      description: "Expand a local time range into array of UTC times at regular intervals. Use this when user requests repeating reminders within a time window (e.g. 'every 30 minutes from 10am to 1pm'). Returns utcTimes array to use as time values in timeTriggers.",
      input_schema: {
        type: 'object',
        properties: {
          fromLocal: {
            type: 'string',
            description: "Start time in local timezone 'HH:MM'",
          },
          toLocal: {
            type: 'string',
            description: "End time in local timezone 'HH:MM'",
          },
          intervalMinutes: {
            type: 'number',
            description: 'Interval in minutes (can be decimal, e.g. 0.333 for 20s)',
          },
          timezone: {
            type: 'string',
            description: "User timezone from Environment section, e.g. 'GMT+2'",
          },
        },
        required: ['fromLocal', 'toLocal', 'intervalMinutes', 'timezone'],
      },
    },
    {
      name: 'calculateRecurringDays',
      description: 'Parse a day-of-week expression into array of day numbers. Use this to determine repeatDays for addRecurringJob. Returns days array where 0=Sunday, 6=Saturday. Empty array means every day.',
      input_schema: {
        type: 'object',
        properties: {
          expression: {
            type: 'string',
            description: "Day expression in Vietnamese or English. Examples: 'thứ 2', 'thứ 2, 4, 6', 'weekdays', 'every day', 'cuối tuần'",
          },
        },
        required: ['expression'],
      },
    },
    {
      name: 'calculateSpecificDates',
      description: 'Tính danh sách ngày cụ thể từ mô tả tự nhiên. PHẢI dùng tool này, không được tự tính. Trả về mảng chuỗi YYYY-MM-DD.',
      input_schema: {
        type: 'object',
        properties: {
          dates: {
            type: 'array',
            items: { type: 'string' },
            description: 'Mô tả từng ngày. Ví dụ: ["ngày 26/4", "ngày 27/4"], ["ngày mai", "2 ngày nữa"], ["10 ngày nữa"]',
          },
          timezone: {
            type: 'string',
            description: "User timezone from Environment section, e.g. 'GMT+2'",
          },
        },
        required: ['dates', 'timezone'],
      },
    },
    {
      name: 'calculateEndTime',
      description: "Calculate end time from a start point and duration. Use when user says 'for 2 hours', 'trong 3 tiếng'. Returns fromUTC and toUTC to use with addOneshotInterval.",
      input_schema: {
        type: 'object',
        properties: {
          startExpression: {
            type: 'string',
            description: "Start time expression: 'now', 'today HH:MM', 'tomorrow HH:MM', or 'now + Xm/Xh'",
          },
          duration: {
            type: 'string',
            description: "Duration string: '2h', '30m', '1h30m', '2h30m'",
          },
          timezone: {
            type: 'string',
            description: "User timezone from Environment section, e.g. 'GMT+2'",
          },
        },
        required: ['startExpression', 'duration', 'timezone'],
      },
    },
    {
      name: 'calculateNextOccurrence',
      description: 'Calculate the next occurrence of a local time — today if not yet passed, tomorrow if already passed. Use this for single reminders at a specific time to avoid scheduling in the past.',
      input_schema: {
        type: 'object',
        properties: {
          targetLocal: {
            type: 'string',
            description: "Target time in local timezone 'HH:MM'",
          },
          timezone: {
            type: 'string',
            description: "User timezone from Environment section, e.g. 'GMT+2'",
          },
        },
        required: ['targetLocal', 'timezone'],
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
            items: { type: 'number' },
            description: 'Days of week (0=Sun, 1=Mon...). Empty array = every day. Bỏ trống [] nếu dùng specificDates.',
          },
          specificDates: {
            type: 'array',
            items: { type: 'string' },
            description: 'Danh sách ngày cụ thể ISO format YYYY-MM-DD (UTC). Nếu có, job chỉ chạy đúng các ngày này, bỏ qua repeatDays.',
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
    {
      name: 'listMasterJobs',
      description: 'Liệt kê tất cả master jobs (recurring jobs) của user. Trả về danh sách job bao gồm repeat_days, specific_dates, và time_triggers.',
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
  ];
}

export default {
  getSchedulerTools,
  calculateTime,
  calculateTimeRange,
  calculateRecurringDays,
  calculateEndTime,
  calculateNextOccurrence,
  calculateSpecificDates
};
