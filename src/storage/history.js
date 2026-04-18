/**
 * Conversation History Storage
 * JSONL-based persistent storage for conversation sessions
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// ============================================================================
// Storage Utilities
// ============================================================================

/**
 * Resolve the base storage directory for Ziron sessions.
 * Defaults to ~/.ziron/sessions/
 * @returns {string}
 */
function resolveStorageDir() {
  return path.join(os.homedir(), '.ziron', 'sessions');
}

/**
 * Resolve the path to a session's JSONL file.
 * @param {string} sessionId
 * @returns {string}
 */
function resolveSessionPath(sessionId) {
  return path.join(resolveStorageDir(), `${sessionId}.jsonl`);
}

/**
 * Ensure the storage directory exists with secure permissions.
 * @returns {Promise<void>}
 */
async function ensureStorageDir() {
  const dir = resolveStorageDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Ensure permissions even if directory already existed
  await fs.chmod(dir, 0o700).catch(() => {
    // Ignore errors (e.g., on Windows where chmod is no-op)
  });
}

/**
 * Set secure file permissions (owner read/write only).
 * Ignored on Windows where chmod is not effective.
 * @param {string} filePath
 * @returns {Promise<void>}
 */
async function setSecureFileMode(filePath) {
  await fs.chmod(filePath, 0o600).catch(() => {
    // Best effort - ignore errors on platforms that don't support chmod
  });
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Create a new session and return its unique identifier.
 * The session ID is a UUIDv4 string.
 *
 * @returns {string} The new session ID
 */
export function createSession() {
  return randomUUID();
}

/**
 * Append a message to a session's history.
 * Writes are atomic using a temp file + rename strategy.
 *
 * @param {string} sessionId - The session identifier
 * @param {Object} message - The message to append (without id and timestamp)
 * @param {string} message.sessionId - Session ID
 * @param {string|null} message.parentId - Parent message ID
 * @param {string} message.role - Message role (user, assistant, tool_use, tool_result, summary)
 * @param {string|Array} message.content - Message content
 * @param {string|null} message.toolName - Tool name (for tool_use/tool_result)
 * @param {string|null} message.toolUseId - Tool use ID (for tool_result)
 * @param {boolean} message.isError - Is error flag (for tool_result)
 * @param {boolean} message.isCompactBoundary - Is compaction boundary
 * @returns {Promise<void>}
 */
export async function appendMessage(sessionId, message) {
  const id = randomUUID();
  const timestamp = new Date().toISOString();

  const fullMessage = {
    ...message,
    id,
    timestamp,
  };

  await ensureStorageDir();

  const sessionPath = resolveSessionPath(sessionId);
  const line = JSON.stringify(fullMessage) + '\n';

  // Direct append is atomic with O_APPEND flag
  await fs.appendFile(sessionPath, line, { encoding: 'utf-8', mode: 0o600 });
  await setSecureFileMode(sessionPath);
}

/**
 * Load all messages from a session's history.
 * Malformed lines and empty lines are silently skipped.
 *
 * @param {string} sessionId - The session identifier
 * @returns {Promise<Array<Object>>} Array of messages in chronological order
 */
export async function loadSession(sessionId) {
  const sessionPath = resolveSessionPath(sessionId);

  try {
    const content = await fs.readFile(sessionPath, 'utf-8');
    const lines = content.split('\n');
    const messages = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const message = JSON.parse(trimmed);
        messages.push(message);
      } catch {
        // Skip malformed lines silently
        continue;
      }
    }

    return messages;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

/**
 * List all sessions in storage with metadata.
 * Reads only the first and last 2048 bytes of each file for efficiency.
 *
 * @returns {Promise<Array<Object>>} Array of session metadata
 */
export async function listSessions() {
  const dir = resolveStorageDir();

  try {
    await ensureStorageDir();
    const entries = await fs.readdir(dir);
    const sessions = [];

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) {
        continue;
      }

      const sessionId = entry.slice(0, -6); // Remove .jsonl
      const filePath = path.join(dir, entry);

      try {
        const stats = await fs.stat(filePath);
        const fileSize = stats.size;

        let content = '';

        if (fileSize <= 4096) {
          // Small file - read entirely
          content = await fs.readFile(filePath, 'utf-8');
        } else {
          // Large file - read first and last 2048 bytes
          const handle = await fs.open(filePath, 'r');
          try {
            const headBuffer = Buffer.alloc(2048);
            const tailBuffer = Buffer.alloc(2048);

            await handle.read(headBuffer, 0, 2048, 0);
            await handle.read(tailBuffer, 0, 2048, fileSize - 2048);

            content = headBuffer.toString('utf-8') + '\n' + tailBuffer.toString('utf-8');
          } finally {
            await handle.close();
          }
        }

        // Parse first and last messages
        const lines = content.split('\n').filter((l) => l.trim());
        if (lines.length === 0) {
          continue;
        }

        let firstTimestamp = '';
        let lastTimestamp = '';

        // Parse first line
        try {
          const firstMsg = JSON.parse(lines[0]);
          firstTimestamp = firstMsg.timestamp;
        } catch {
          // Skip if malformed
          continue;
        }

        // Parse last complete line
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const lastMsg = JSON.parse(lines[i]);
            lastTimestamp = lastMsg.timestamp;
            break;
          } catch {
            continue;
          }
        }

        if (!lastTimestamp) {
          lastTimestamp = firstTimestamp;
        }

        // Count newlines for message count estimate
        const messageCount = lines.length;

        sessions.push({
          sessionId,
          firstTimestamp,
          lastTimestamp,
          messageCount,
        });
      } catch {
        // Skip files that can't be read
        continue;
      }
    }

    return sessions.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

/**
 * Append a summary message and mark it as a compact boundary.
 * Messages before this boundary will be excluded from API message conversion.
 *
 * @param {string} sessionId - The session identifier
 * @param {string} summaryText - The summary text to append
 * @returns {Promise<void>}
 */
export async function truncateAndSummarize(sessionId, summaryText) {
  await appendMessage(sessionId, {
    sessionId,
    parentId: null,
    role: 'summary',
    content: summaryText,
    toolName: null,
    toolUseId: null,
    isError: false,
    isCompactBoundary: true,
  });
}

/**
 * Build API-formatted messages from session history.
 * Starts from the last compact boundary (or beginning if none exists).
 * Handles tool_use and tool_result conversion and merges consecutive user messages.
 *
 * @param {string} sessionId - The session identifier
 * @returns {Promise<Array<Object>>} Array of API-formatted messages ready for LLM consumption
 */
export async function buildApiMessages(sessionId) {
  const messages = await loadSession(sessionId);

  // Find last compact boundary
  let startIndex = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isCompactBoundary) {
      startIndex = i + 1;
      break;
    }
  }

  // Process messages after boundary
  const relevantMessages = messages.slice(startIndex);
  const result = [];

  for (const msg of relevantMessages) {
    // Skip summary messages
    if (msg.role === 'summary') {
      continue;
    }

    if (msg.role === 'user') {
      // Add user message
      result.push({
        role: 'user',
        content: msg.content,
      });
    } else if (msg.role === 'assistant') {
      // Add assistant message
      result.push({
        role: 'assistant',
        content: msg.content,
      });
    } else if (msg.role === 'tool_use') {
      // Append to preceding assistant message
      if (result.length > 0 && result[result.length - 1].role === 'assistant') {
        const lastMsg = result[result.length - 1];

        // Ensure content is array
        if (typeof lastMsg.content === 'string') {
          lastMsg.content = [{ type: 'text', text: lastMsg.content }];
        } else if (!Array.isArray(lastMsg.content)) {
          lastMsg.content = [];
        }

        // Append tool_use block
        lastMsg.content.push({
          type: 'tool_use',
          id: msg.id,
          name: msg.toolName,
          input: msg.content,
        });
      }
    } else if (msg.role === 'tool_result') {
      // Create or merge into user message
      const toolResultBlock = {
        type: 'tool_result',
        tool_use_id: msg.toolUseId,
        content: msg.content,
        is_error: msg.isError,
      };

      // Check if last message is user - merge if so
      if (result.length > 0 && result[result.length - 1].role === 'user') {
        const lastMsg = result[result.length - 1];

        // Ensure content is array
        if (typeof lastMsg.content === 'string') {
          lastMsg.content = [{ type: 'text', text: lastMsg.content }];
        } else if (!Array.isArray(lastMsg.content)) {
          lastMsg.content = [];
        }

        lastMsg.content.push(toolResultBlock);
      } else {
        // Create new user message
        result.push({
          role: 'user',
          content: [toolResultBlock],
        });
      }
    }
  }

  return result;
}

export default {
  createSession,
  appendMessage,
  loadSession,
  listSessions,
  truncateAndSummarize,
  buildApiMessages,
};
