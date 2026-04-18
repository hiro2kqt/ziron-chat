/**
 * Config management commands
 */

import { loadConfig, saveConfig, updateConfig, getConfigPath } from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * Show current config
 */
export async function showConfigCommand() {
  const configPath = getConfigPath();

  if (!configPath) {
    logger.warn('No config file found');
    logger.info('Config is loaded from environment variables');
    logger.info('Run: ziron onboarding  (to generate config.json)\n');
  } else {
    logger.info(`Config file: ${configPath}\n`);
  }

  const config = loadConfig();

  // Redact sensitive values
  const display = JSON.parse(JSON.stringify(config));

  if (display.providers.openrouter.apiKey) {
    display.providers.openrouter.apiKey = '****' + display.providers.openrouter.apiKey.slice(-4);
  }

  if (display.providers.openai.apiKey) {
    display.providers.openai.apiKey = '****' + display.providers.openai.apiKey.slice(-4);
  }

  if (display.providers.openai.oauth.accessToken) {
    display.providers.openai.oauth.accessToken = '****';
    display.providers.openai.oauth.refreshToken = '****';
  }

  if (display.telegram.botToken) {
    display.telegram.botToken = '****' + display.telegram.botToken.slice(-4);
  }

  console.log(JSON.stringify(display, null, 2));
}

/**
 * Set a config value
 */
export async function setConfigCommand(key, value) {
  if (!key || value === undefined) {
    logger.error('Usage: ziron config set <key> <value>');
    logger.info('Example: ziron config set providers.openrouter.model "gpt-4"');
    process.exit(1);
  }

  const keys = key.split('.');
  const update = {};
  let current = update;

  for (let i = 0; i < keys.length - 1; i++) {
    current[keys[i]] = {};
    current = current[keys[i]];
  }

  current[keys[keys.length - 1]] = value;

  try {
    updateConfig(update);
    logger.success(`Set ${key} = ${value}`);
    logger.info('Config updated in config.json');
  } catch (err) {
    logger.error('Failed to update config:', err.message);
    process.exit(1);
  }
}

/**
 * Get a config value
 */
export async function getConfigCommand(key) {
  if (!key) {
    logger.error('Usage: ziron config get <key>');
    logger.info('Example: ziron config get providers.openrouter.model');
    process.exit(1);
  }

  const config = loadConfig();
  const keys = key.split('.');
  let value = config;

  for (const k of keys) {
    value = value?.[k];
  }

  if (value === undefined) {
    logger.warn(`Config key not found: ${key}`);
  } else {
    // Redact if sensitive
    if (key.includes('apiKey') || key.includes('Token') || key.includes('token')) {
      if (typeof value === 'string') {
        console.log('****' + value.slice(-4));
      } else {
        console.log('****');
      }
    } else {
      console.log(JSON.stringify(value, null, 2));
    }
  }
}

export default { showConfigCommand, setConfigCommand, getConfigCommand };
