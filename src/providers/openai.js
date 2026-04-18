/**
 * OpenAI API Client
 * Supports both API key and OAuth
 */

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4';
const DEFAULT_MAX_TOKENS = 500;

/**
 * @typedef {Object} Message
 * @property {'system'|'user'|'assistant'} role
 * @property {string} content
 */

/**
 * @typedef {Object} CompletionOptions
 * @property {string} [model]
 * @property {number} [maxTokens]
 * @property {number} [temperature]
 */

/**
 * Make a chat completion request
 * @param {Message[]} messages
 * @param {string|Object} auth - API key string or {accessToken: string}
 * @param {CompletionOptions} [options]
 * @returns {Promise<Object>}
 */
export async function complete(messages, auth, options = {}) {
  if (!auth) {
    throw new Error('OpenAI auth required (API key or OAuth token)');
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('Messages array required');
  }

  const authHeader = typeof auth === 'string'
    ? `Bearer ${auth}`  // API key
    : `Bearer ${auth.accessToken}`;  // OAuth

  const payload = {
    model: options.model || DEFAULT_MODEL,
    messages: messages,
    max_tokens: options.maxTokens || DEFAULT_MAX_TOKENS,
    temperature: options.temperature ?? 1.0,
  };

  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${error}`);
  }

  return await response.json();
}

/**
 * Simple text completion helper
 * @param {string} prompt
 * @param {string|Object} auth
 * @param {CompletionOptions} [options]
 * @returns {Promise<string>}
 */
export async function chat(prompt, auth, options = {}) {
  const messages = [{ role: 'user', content: prompt }];
  const result = await complete(messages, auth, options);

  if (!result.choices || !result.choices[0]) {
    throw new Error('Invalid API response: no choices');
  }

  return result.choices[0].message.content;
}

/**
 * Validate API key
 * @param {string} apiKey
 * @returns {Promise<boolean>}
 */
export async function validateApiKey(apiKey) {
  try {
    await chat('Hi', apiKey, { maxTokens: 10 });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Refresh OAuth token
 * @param {string} refreshToken
 * @returns {Promise<Object>} {accessToken, refreshToken, expiresAt}
 */
export async function refreshOAuthToken(refreshToken) {
  // TODO: Implement OAuth refresh
  throw new Error('OAuth refresh not yet implemented');
}

export default { complete, chat, validateApiKey, refreshOAuthToken };
