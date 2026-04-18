/**
 * OpenRouter API Client
 * Simplified implementation - OpenAI-compatible API
 */

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'anthropic/claude-3.5-sonnet';
const DEFAULT_MAX_TOKENS = 4096;

/**
 * @typedef {Object} Message
 * @property {'system'|'user'|'assistant'} role
 * @property {string} content
 */

/**
 * @typedef {Object} CompletionOptions
 * @property {string} [model] - Model ID (default: claude-3.5-sonnet)
 * @property {number} [maxTokens] - Max tokens to generate
 * @property {number} [temperature] - Temperature 0-2
 */

/**
 * Make a chat completion request
 * @param {Message[]} messages - Conversation messages
 * @param {string} apiKey - OpenRouter API key
 * @param {CompletionOptions} [options] - Additional options
 * @returns {Promise<Object>} - API response
 */
export async function complete(messages, apiKey, options = {}) {
  if (!apiKey) {
    throw new Error('OpenRouter API key required');
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('Messages array required');
  }

  const payload = {
    model: options.model || DEFAULT_MODEL,
    messages: messages,
    max_tokens: options.maxTokens || DEFAULT_MAX_TOKENS,
    temperature: options.temperature ?? 1.0,
  };

  const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/yourusername/ziron',
      'X-Title': 'Ziron',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
  }

  return await response.json();
}

/**
 * Simple text completion helper
 * @param {string} prompt - User prompt
 * @param {string} apiKey - OpenRouter API key
 * @param {CompletionOptions} [options] - Additional options
 * @returns {Promise<string>} - Generated text
 */
export async function chat(prompt, apiKey, options = {}) {
  const messages = [{ role: 'user', content: prompt }];
  const result = await complete(messages, apiKey, options);

  if (!result.choices || !result.choices[0]) {
    throw new Error('Invalid API response: no choices');
  }

  return result.choices[0].message.content;
}

/**
 * Get available models (mock for now)
 * @returns {Promise<Object[]>}
 */
export async function listModels() {
  return [
    {
      id: 'anthropic/claude-3.5-sonnet',
      name: 'Claude 3.5 Sonnet',
      contextWindow: 200000,
    },
    {
      id: 'openai/gpt-4',
      name: 'GPT-4',
      contextWindow: 128000,
    },
    {
      id: 'anthropic/claude-3-opus',
      name: 'Claude 3 Opus',
      contextWindow: 200000,
    },
  ];
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

export default { complete, chat, listModels, validateApiKey };
