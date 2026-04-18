/**
 * Provider-Agnostic LLM Client
 * Manages conversation history and tool calling loop
 */

import { appendMessage, buildApiMessages } from '../storage/history.js';

// ============================================================================
// ZironClient
// ============================================================================

/**
 * High-level LLM client with conversation history management and tool calling.
 *
 * Responsibilities:
 * - Manages conversation history persistence
 * - Handles tool calling loop
 * - Converts between storage format and API format
 * - Provider-agnostic (works with any LLMProvider implementation)
 */
export class ZironClient {
  /**
   * @param {Object} provider - LLM provider implementation
   */
  constructor(provider) {
    this.provider = provider;
  }

  /**
   * Run a conversation turn with the LLM.
   * Automatically handles tool calling loop and history persistence.
   *
   * @param {Object} params - Run parameters
   * @param {string} params.sessionId - The session identifier
   * @param {string} params.userMessage - The user's message
   * @param {string} params.systemPrompt - System prompt for the LLM
   * @param {Array} [params.tools] - Optional tool definitions
   * @param {Function} [params.onToolCall] - Optional callback for tool execution
   * @returns {Promise<string>} The final assistant response text
   *
   * @throws {Error} If tool calling fails or LLM returns error
   */
  async run(params) {
    const { sessionId, userMessage, systemPrompt, tools, onToolCall } = params;

    // Step 1: Append user message to history
    await appendMessage(sessionId, {
      sessionId,
      parentId: null,
      role: 'user',
      content: userMessage,
      toolName: null,
      toolUseId: null,
      isError: false,
      isCompactBoundary: false,
    });

    // Tool calling loop
    let loopCount = 0;
    const MAX_TOOL_LOOPS = 10; // Prevent infinite loops

    while (loopCount < MAX_TOOL_LOOPS) {
      loopCount++;

      // Step 2: Build API messages from history
      const messages = await buildApiMessages(sessionId);

      // Step 3: Call LLM
      const response = await this.provider.chat({
        system: systemPrompt,
        messages,
        tools,
        max_tokens: 8192,
      });

      // Step 4: Handle tool use
      if (response.stop_reason === 'tool_use') {
        // Find tool_use block
        const toolUseBlock = response.content.find((block) => block.type === 'tool_use');

        if (!toolUseBlock) {
          throw new Error('LLM returned tool_use stop reason but no tool_use block found');
        }

        if (!onToolCall) {
          throw new Error(
            `LLM wants to call tool "${toolUseBlock.name}" but no onToolCall handler provided`
          );
        }

        // Append assistant message with tool_use (if there's text content too)
        const textBlocks = response.content.filter((block) => block.type === 'text');
        if (textBlocks.length > 0) {
          await appendMessage(sessionId, {
            sessionId,
            parentId: null,
            role: 'assistant',
            content: response.content,
            toolName: null,
            toolUseId: null,
            isError: false,
            isCompactBoundary: false,
          });
        }

        // Append tool_use message
        await appendMessage(sessionId, {
          sessionId,
          parentId: null,
          role: 'tool_use',
          content: toolUseBlock.input,
          toolName: toolUseBlock.name,
          toolUseId: null,
          isError: false,
          isCompactBoundary: false,
        });

        // Execute tool
        let toolResult;
        let toolError = false;

        try {
          toolResult = await onToolCall(toolUseBlock.name, toolUseBlock.input);
        } catch (err) {
          toolResult = `Tool execution failed: ${err instanceof Error ? err.message : String(err)}`;
          toolError = true;
        }

        // Append tool_result message
        await appendMessage(sessionId, {
          sessionId,
          parentId: null,
          role: 'tool_result',
          content: toolResult,
          toolName: null,
          toolUseId: toolUseBlock.id,
          isError: toolError,
          isCompactBoundary: false,
        });

        // Continue loop to get next response
        continue;
      }

      // Step 5: Extract final text response
      const textBlocks = response.content.filter((block) => block.type === 'text');

      const finalText = textBlocks.map((block) => block.text).join('\n\n');

      // Step 6: Append assistant message
      await appendMessage(sessionId, {
        sessionId,
        parentId: null,
        role: 'assistant',
        content: finalText,
        toolName: null,
        toolUseId: null,
        isError: false,
        isCompactBoundary: false,
      });

      // Step 7: Return final text
      return finalText;
    }

    throw new Error(`Tool calling loop exceeded maximum iterations (${MAX_TOOL_LOOPS})`);
  }
}

/**
 * Create a new ZironClient instance with the given provider.
 *
 * @param {Object} provider - The LLM provider implementation
 * @returns {ZironClient} A new client instance
 *
 * @example
 * ```js
 * const client = createClient(new OpenRouterProvider(apiKey));
 * const response = await client.run({
 *   sessionId: 'abc-123',
 *   userMessage: 'Hello!',
 *   systemPrompt: 'You are a helpful assistant.'
 * });
 * ```
 */
export function createClient(provider) {
  return new ZironClient(provider);
}

export default { ZironClient, createClient };
