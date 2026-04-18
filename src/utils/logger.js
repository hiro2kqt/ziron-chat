/**
 * Simple console logger with levels
 */

const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const envLevel = process.env.LOG_LEVEL ? process.env.LOG_LEVEL.trim().toLowerCase() : null;

let currentLevel = envLevel && LEVELS[envLevel] !== undefined
  ? LEVELS[envLevel]
  : LEVELS.info;

export function setLogLevel(level) {
  if (LEVELS[level] !== undefined) {
    currentLevel = LEVELS[level];
  }
}

export function error(...args) {
  if (currentLevel >= LEVELS.error) {
    console.error('[ERROR]', ...args);
  }
}

export function warn(...args) {
  if (currentLevel >= LEVELS.warn) {
    console.warn('[WARN]', ...args);
  }
}

export function info(...args) {
  if (currentLevel >= LEVELS.info) {
    console.log('[INFO]', ...args);
  }
}

export function debug(...args) {
  if (currentLevel >= LEVELS.debug) {
    console.log('[DEBUG]', ...args);
  }
}

export function success(...args) {
  if (currentLevel >= LEVELS.info) {
    console.log('✓', ...args);
  }
}

export default { error, warn, info, debug, success, setLogLevel };
