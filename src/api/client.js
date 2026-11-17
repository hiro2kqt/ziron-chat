/**
 * Provider-Agnostic LLM Client
 * Manages conversation history and tool calling loop
 */

import { appendMessage, buildApiMessages, loadSession, truncateAndSummarize } from '../storage/history.js';
import logger from '../utils/logger.js';

// History compaction: once the active history (since the last summary) is
// larger than this, older turns are replaced by an LLM summary.
const COMPACT_THRESHOLD_TOKENS = 8000;
// Most recent user turns kept verbatim after the summary, within a token
// budget (tool results like job lists can make a single turn several k tokens)
const COMPACT_KEEP_TURNS = 2;
const COMPACT_KEEP_BUDGET_TOKENS = 2500;

const SUMMARY_SYSTEM = `You compress the older part of a chat between Hiro and the assistant ZIRON so the
conversation can continue naturally. Keep only what is still relevant going forward: open requests or questions,
decisions and preferences Hiro expressed, things Hiro explicitly asked to remember.
Do NOT include:
- lists of reminders/jobs/schedules or their times (the scheduler database is the source of truth),
- timezone offsets like GMT+N (the system provides the current timezone),
- email contents, university course details, weather reports, raw tool output,
- greetings or tasks that are already finished.
Write at most 8 short bullet points in English. If nothing is still relevant, write "- (nothing pending)".
Output only the bullets.`;

/** Rough token estimate (~3.5 chars per token for mixed vi/en JSON) */
function estimateTokens(messages) {
  return Math.round(JSON.stringify(messages.map(m => m.content)).length / 3.5);
}

/** Plain-text transcript of stored messages for the summarizer */
function toTranscript(messages) {
  const clip = (v, n) => {
    const t = typeof v === 'string' ? v : JSON.stringify(v);
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  return messages.map(m => {
    switch (m.role) {
      case 'summary': return `Earlier summary:\n${m.content}`;
      case 'user': return `Hiro: ${clip(m.content, 2000)}`;
      case 'assistant': return m.content ? `ZIRON: ${clip(m.content, 2000)}` : '';
      case 'tool_use': return `[tool ${m.toolName}(${clip(m.content, 200)})]`;
      case 'tool_result': return `[result: ${clip(m.content, 300)}]`;
      default: return '';
    }
  }).filter(Boolean).join('\n');
}

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
   * @param {Array<{path: string, mime: string}>} [params.images] - Images attached to this message
   * @returns {Promise<string>} The final assistant response text
   *
   * @throws {Error} If tool calling fails or LLM returns error
   */
  /**
   * Summarize older turns once the active history gets large. Runs before a
   * new user message is appended, i.e. at a clean turn boundary, so no
   * tool_use/tool_result pair is ever split.
   * @param {string} sessionId
   * @returns {Promise<boolean>} true if compacted
   */
  async compactIfNeeded(sessionId) {
    try {
      const all = await loadSession(sessionId);
      let start = 0;
      for (let i = all.length - 1; i >= 0; i--) {
        if (all[i].isCompactBoundary) { start = i; break; }
      }
      const active = all.slice(start);
      const tokens = estimateTokens(active);
      if (tokens < COMPACT_THRESHOLD_TOKENS) return false;

      // Keep up to COMPACT_KEEP_TURNS whole turns from the end while they fit
      // the budget; keeping 0 is fine (previous turns are complete)
      const userIdx = active.map((m, i) => (m.role === 'user' ? i : -1)).filter(i => i >= 0);
      let cut = active.length;
      for (let k = 1; k <= COMPACT_KEEP_TURNS && k <= userIdx.length; k++) {
        const candidate = userIdx[userIdx.length - k];
        if (estimateTokens(active.slice(candidate)) > COMPACT_KEEP_BUDGET_TOKENS) break;
        cut = candidate;
      }
      const older = active.slice(0, cut);
      const recent = active.slice(cut);
      if (older.length === 0) return false;

      const ask = () => this.provider.chat({
        system: SUMMARY_SYSTEM,
        messages: [{ role: 'user', content: toTranscript(older) }],
        // Reasoning models spend part of max_tokens thinking; 1500 left the
        // summary empty on a 40k-token history
        max_tokens: 6000,
        reasoning: { effort: 'low', exclude: true },
      });
      const textOf = r => (r.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      let summary = textOf(await ask());
      if (!summary) summary = textOf(await ask()); // reasoning models occasionally return no text
      if (!summary) {
        logger.warn('[Compact] Empty summary, skipping compaction');
        return false;
      }

      // Boundary = summary; then re-append the kept turns after it (same
      // toolUseIds, so tool pairs still match)
      await truncateAndSummarize(sessionId, summary);
      for (const m of recent) {
        const { id, timestamp, ...rest } = m;
        // compactCopy: re-appended verbatim, so memory extraction skips it
        await appendMessage(sessionId, { ...rest, isCompactBoundary: false, compactCopy: true });
      }
      const keptTurns = recent.filter(m => m.role === 'user').length;
      logger.info(`[Compact] Session ${sessionId.slice(0, 8)}: ~${tokens} tokens -> summary + last ${keptTurns} turn(s) (~${estimateTokens(recent) + Math.round(summary.length / 3.5)} tokens)`);
      return true;
    } catch (err) {
      // Never block the conversation on compaction
      logger.warn('[Compact] Failed:', err.message);
      return false;
    }
  }

  async run(params) {
    const { sessionId, userMessage, systemPrompt, tools, onToolCall, images } = params;

    await this.compactIfNeeded(sessionId);

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
      // [{path, mime}] stored by saveSessionImage; sent only with this turn
      ...(images?.length ? { images } : {}),
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
        const toolUseBlocks = response.content.filter((block) => block.type === 'tool_use');
        
        if (toolUseBlocks.length === 0) {
          throw new Error('LLM returned tool_use stop reason but no tool_use block found');
        }

        if (!onToolCall) {
          throw new Error(`LLM wants to call tools but no onToolCall handler provided`);
        }

        // Always append assistant message first
        const textBlocks = response.content.filter((block) => block.type === 'text');
        const textContent = textBlocks.map((block) => block.text).join('\n\n');
        
        await appendMessage(sessionId, {
          sessionId,
          parentId: null,
          role: 'assistant',
          content: textContent || '', // Empty string if no text
          toolName: null,
          toolUseId: null,
          isError: false,
          isCompactBoundary: false,
        });

        // Process all tool calls concurrently or sequentially
        for (const toolBlock of toolUseBlocks) {
          // Append tool_use message
          await appendMessage(sessionId, {
            sessionId,
            parentId: null,
            role: 'tool_use',
            content: toolBlock.input,
            toolName: toolBlock.name,
            toolUseId: toolBlock.id,
            isError: false,
            isCompactBoundary: false,
          });

          // Execute tool
          let toolResult;
          let toolError = false;

          try {
            toolResult = await onToolCall(toolBlock.name, toolBlock.input);
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
            toolUseId: toolBlock.id,
            isError: toolError,
            isCompactBoundary: false,
          });
        }

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
