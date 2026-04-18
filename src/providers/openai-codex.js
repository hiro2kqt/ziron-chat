/**
 * OpenAI Codex (ChatGPT OAuth) Provider
 * Uses the Responses API at chatgpt.com/backend-api
 */

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';

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
 * Convert messages to Responses API input format
 * @param {Message[]} messages
 * @returns {Array}
 */
function convertMessagesToResponsesInput(messages) {
  const input = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      input.push({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: msg.content }],
      });
    } else if (msg.role === 'assistant') {
      input.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: msg.content }],
      });
    }
  }

  return input;
}

/**
 * Make a chat completion request using Responses API
 * @param {Message[]} messages
 * @param {Object} auth - {accessToken: string}
 * @param {CompletionOptions} [options]
 * @returns {Promise<string>}
 */
export async function complete(messages, auth, options = {}) {
  if (!auth?.accessToken) {
    throw new Error('OpenAI Codex OAuth access token required');
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('Messages array required');
  }

  const model = options.model || 'gpt-5.4';
  const input = convertMessagesToResponsesInput(messages);

  // System prompt goes in instructions, not input array
  const systemMessage = messages.find(m => m.role === 'system');

  const payload = {
    model: model,
    input: input.filter(i => i.role !== 'system'),
    stream: false,  // Use non-streaming for simplicity
    max_output_tokens: options.maxTokens || 500,
    temperature: options.temperature ?? 1.0,
  };

  if (systemMessage) {
    payload.instructions = systemMessage.content;
  }

  const response = await fetch(`${CODEX_BASE_URL}/v1/responses`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI Codex API error: ${response.status} - ${error}`);
  }

  const result = await response.json();

  // Extract text from response output
  if (!result.output || !Array.isArray(result.output)) {
    throw new Error('Invalid API response: no output array');
  }

  // Find the assistant message in output
  for (const item of result.output) {
    if (item.type === 'message' && item.role === 'assistant') {
      if (item.content && Array.isArray(item.content)) {
        for (const content of item.content) {
          if (content.type === 'output_text' && content.text) {
            return content.text;
          }
        }
      }
    }
  }

  throw new Error('No assistant response found in output');
}

/**
 * Simple text completion helper
 * @param {string} prompt
 * @param {Object} auth - {accessToken: string}
 * @param {CompletionOptions} [options]
 * @returns {Promise<string>}
 */
export async function chat(prompt, auth, options = {}) {
  const messages = [{ role: 'user', content: prompt }];
  return await complete(messages, auth, options);
}

export default { complete, chat };
