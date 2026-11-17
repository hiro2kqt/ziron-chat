/**
 * OpenRouter API Client
 * Simplified implementation - OpenAI-compatible API
 */

import logger from '../utils/logger.js';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'anthropic/claude-3.5-sonnet';
const DEFAULT_MAX_TOKENS = 4096;
// Route only to upstreams that don't store or train on prompts: requests carry
// personal mail, schedules and chat. Override per call with options.provider.
// sort: 'price' = always the cheapest eligible upstream (next one on errors).
// Default load balancing picked a random upstream per call, so the
// provider-side prompt cache never hit: 3-7x the cost of a cached call.
// ignore: sail-research (fp4) missed important mails in the 2026-11-17 eval;
// it was the fallback when the cheapest upstream failed (5 of 268 calls).
export const PRIVATE_ROUTING = { data_collection: 'deny', sort: 'price', ignore: ['sail-research'] };

/**
 * One log line per call: upstream, tokens, cache hits, cost. Keeps routing
 * and spend visible in `pm2 logs ziron`.
 * @param {string} tag - caller, e.g. 'chat' or the model id
 * @param {Object} data - OpenRouter response JSON
 */
export function logUsage(tag, data) {
  const u = data?.usage;
  if (!u) return;
  const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
  const cost = typeof u.cost === 'number' ? ` cost=${u.cost.toFixed(6)}` : '';
  logger.info(`[LLM usage] ${tag} via ${data.provider || '?'} in=${u.prompt_tokens} cached=${cached} out=${u.completion_tokens}${cost}`);
}

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
  // e.g. { effort: 'low' } or { enabled: false } for reasoning-capable models
  if (options.reasoning) payload.reasoning = options.reasoning;
  // e.g. { type: 'json_schema', json_schema: {...} } for structured output
  if (options.responseFormat) payload.response_format = options.responseFormat;
  payload.provider = options.provider ?? PRIVATE_ROUTING;

  const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/yourusername/ziron',
      'X-Title': 'Ziron',
    },
    body: JSON.stringify(payload),
    // A hung request must not stall callers forever (the email checker is
    // serialized, so one stuck call would block every later check)
    signal: AbortSignal.timeout(options.timeoutMs ?? 120000),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  logUsage(options.usageTag || payload.model, data);
  return data;
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
