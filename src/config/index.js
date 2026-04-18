/**
 * Configuration loader
 * Loads from .env, config.json, or config.yaml
 * Priority: config.json > .env > defaults
 */

import { config as loadDotenv } from 'dotenv';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DEFAULT_CONFIG, mergeWithDefaults } from './schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '../..');
const CONFIG_JSON_PATH = join(ROOT_DIR, 'config.json');
const CONFIG_YAML_PATH = join(ROOT_DIR, 'config.yaml');

// Load .env file
loadDotenv({ path: join(ROOT_DIR, '.env') });

/**
 * Get config file path (prefer JSON)
 * @returns {string|null}
 */
export function getConfigPath() {
  if (existsSync(CONFIG_JSON_PATH)) {
    return CONFIG_JSON_PATH;
  }
  if (existsSync(CONFIG_YAML_PATH)) {
    return CONFIG_YAML_PATH;
  }
  return null;
}

/**
 * Load config from file
 * @returns {Object|null}
 */
function loadConfigFile() {
  const configPath = getConfigPath();

  if (!configPath) {
    return null;
  }

  try {
    const content = readFileSync(configPath, 'utf8');

    if (configPath.endsWith('.json')) {
      return JSON.parse(content);
    } else if (configPath.endsWith('.yaml') || configPath.endsWith('.yml')) {
      return parseYaml(content);
    }
  } catch (err) {
    console.error(`Failed to load config from ${configPath}:`, err.message);
  }

  return null;
}

/**
 * Load config from all sources (file + env)
 * @returns {Object} config
 */
export function loadConfig() {
  let config = loadConfigFile();

  // If no config file, build from env
  if (!config) {
    config = {
      providers: {
        openrouter: {
          apiKey: process.env.OPENROUTER_API_KEY || '',
        },
        openai: {
          apiKey: process.env.OPENAI_API_KEY || '',
        },
      },
      telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      },
    };
  }

  // Env vars override config file
  if (process.env.OPENROUTER_API_KEY) {
    config.providers = config.providers || {};
    config.providers.openrouter = config.providers.openrouter || {};
    config.providers.openrouter.apiKey = process.env.OPENROUTER_API_KEY;
  }

  if (process.env.OPENAI_API_KEY) {
    config.providers = config.providers || {};
    config.providers.openai = config.providers.openai || {};
    config.providers.openai.apiKey = process.env.OPENAI_API_KEY;
  }

  if (process.env.TELEGRAM_BOT_TOKEN) {
    config.telegram = config.telegram || {};
    config.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN;
  }

  // Merge with defaults
  return mergeWithDefaults(config);
}

/**
 * Save config to config.json
 * @param {Object} config
 */
export function saveConfig(config) {
  const merged = mergeWithDefaults(config);
  const json = JSON.stringify(merged, null, 2);
  writeFileSync(CONFIG_JSON_PATH, json, 'utf8');
  return merged;
}

/**
 * Update specific config values
 * @param {Object} updates - Partial config to merge
 * @returns {Object} Updated config
 */
export function updateConfig(updates) {
  const current = loadConfig();
  const merged = deepMerge(current, updates);
  return saveConfig(merged);
}

/**
 * Deep merge objects
 */
function deepMerge(target, source) {
  const result = { ...target };

  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }

  return result;
}

/**
 * Check if config file exists
 * @returns {boolean}
 */
export function configExists() {
  return getConfigPath() !== null;
}

/**
 * Validate required config fields
 * @param {Object} config
 * @param {string[]} required - Array of dot-notation paths like 'providers.openrouter.apiKey'
 * @returns {Object} { valid: boolean, missing: string[] }
 */
export function validateRequiredFields(config, required = []) {
  const missing = [];

  for (const path of required) {
    const keys = path.split('.');
    let value = config;

    for (const key of keys) {
      value = value?.[key];
    }

    if (!value) {
      missing.push(path);
    }
  }

  return {
    valid: missing.length === 0,
    missing,
  };
}

export default {
  loadConfig,
  saveConfig,
  updateConfig,
  configExists,
  validateRequiredFields,
  getConfigPath,
  DEFAULT_CONFIG,
};
