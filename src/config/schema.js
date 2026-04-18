/**
 * Configuration schema and defaults
 */

export const DEFAULT_CONFIG = {
  version: '0.1.0',
  providers: {
    openrouter: {
      apiKey: '',
      model: 'anthropic/claude-3.5-sonnet',
      maxTokens: 500,
    },
    openai: {
      apiKey: '',
      model: 'gpt-4',
      maxTokens: 500,
      // OAuth credentials (if using OAuth instead of API key)
      oauth: {
        accessToken: '',
        refreshToken: '',
        expiresAt: null,
        email: '',
      },
    },
  },
  telegram: {
    botToken: '',
  },
  settings: {
    logLevel: 'info',
  },
  user: {
    timezone: '',
    location: '',
    name: 'Hiro',
  },
};

/**
 * Validate config structure
 * @param {Object} config
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateConfig(config) {
  const errors = [];

  if (!config.version) {
    errors.push('Missing config.version');
  }

  if (!config.providers) {
    errors.push('Missing config.providers');
  }

  if (!config.telegram) {
    errors.push('Missing config.telegram');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Merge config with defaults
 * @param {Object} config
 * @returns {Object}
 */
export function mergeWithDefaults(config) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    providers: {
      ...DEFAULT_CONFIG.providers,
      ...(config.providers || {}),
      openrouter: {
        ...DEFAULT_CONFIG.providers.openrouter,
        ...(config.providers?.openrouter || {}),
      },
      openai: {
        ...DEFAULT_CONFIG.providers.openai,
        ...(config.providers?.openai || {}),
        oauth: {
          ...DEFAULT_CONFIG.providers.openai.oauth,
          ...(config.providers?.openai?.oauth || {}),
        },
      },
    },
    telegram: {
      ...DEFAULT_CONFIG.telegram,
      ...(config.telegram || {}),
    },
    settings: {
      ...DEFAULT_CONFIG.settings,
      ...(config.settings || {}),
    },
    user: {
      ...DEFAULT_CONFIG.user,
      ...(config.user || {}),
    },
  };
}

export default { DEFAULT_CONFIG, validateConfig, mergeWithDefaults };
