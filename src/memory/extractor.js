/**
 * Memory Extraction System
 * Automatically extracts and persists long-term memories from conversations
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadSession } from '../storage/history.js';
import logger from '../utils/logger.js';

// ============================================================================
// Configuration
// ============================================================================

const MEMORY_EXTRACTION_INTERVAL = 3; // Extract memory every N messages
const MEMORY_DIR = path.join(os.homedir(), '.ziron', 'memory');
const MEMORY_INDEX_FILE = path.join(MEMORY_DIR, 'MEMORY.md');
const MEMORY_PREVIEW_LENGTH = 500; // Characters to show in index

// Memory file mapping
const MEMORY_FILES = {
  user: path.join(MEMORY_DIR, 'user.md'),
  feedback: path.join(MEMORY_DIR, 'feedback.md'),
  project: path.join(MEMORY_DIR, 'project.md'),
  reference: path.join(MEMORY_DIR, 'reference.md'),
};

// ============================================================================
// Public API
// ============================================================================

/**
 * Check if memory extraction should be triggered
 * @param {number} messageCount - Current message count for the session
 * @returns {boolean} True if should extract memory
 */
export function shouldExtractMemory(messageCount) {
  return messageCount > 0 && messageCount % MEMORY_EXTRACTION_INTERVAL === 0;
}

/**
 * Extract memory from a conversation session
 * Runs a background LLM call to identify what's worth remembering
 *
 * @param {string} sessionId - Session to extract from
 * @param {Object} provider - LLM provider instance (must have .chat() method)
 * @returns {Promise<Object|null>} Extracted memory object or null if nothing to save
 */
export async function extractMemory(sessionId, provider) {
  try {
    logger.info(`[Memory] Extracting from session ${sessionId.substring(0, 8)}...`);

    // 1. Load conversation history
    const messages = await loadSession(sessionId);

    if (messages.length === 0) {
      logger.debug('[Memory] No messages to extract from');
      return null;
    }

    // 2. Load current memory index
    const currentMemory = await loadMemoryIndex();

    // 3. Format conversation for extraction
    const conversationText = formatConversationForExtraction(messages);

    // 4. Build extraction prompt
    const extractionPrompt = buildExtractionPrompt(currentMemory, conversationText);

    // 5. Call LLM to extract memory (direct provider call, no history)
    const response = await provider.chat({
      system: extractionPrompt.system,
      messages: extractionPrompt.messages,
      max_tokens: 2000,
    });

    // 6. Parse response
    const extracted = parseExtractionResponse(response);

    if (!extracted) {
      logger.debug('[Memory] Nothing worth saving');
      return null;
    }

    // 7. Write to memory files
    await writeMemory(extracted);

    logger.success('[Memory] Extraction complete');
    return extracted;

  } catch (err) {
    logger.error('[Memory] Extraction failed:', err.message);
    // Don't throw - memory extraction should never crash the main flow
    return null;
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Load current memory index content
 * @returns {Promise<string>} Memory index content or empty string
 */
async function loadMemoryIndex() {
  try {
    const content = await fs.readFile(MEMORY_INDEX_FILE, 'utf-8');
    return content.trim();
  } catch (err) {
    if (err.code === 'ENOENT') {
      return '';
    }
    throw err;
  }
}

/**
 * Format conversation messages for extraction prompt
 * @param {Array} messages - Message objects from storage
 * @returns {string} Formatted conversation text
 */
function formatConversationForExtraction(messages) {
  const lines = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      lines.push(`Hiro: ${msg.content}`);
    } else if (msg.role === 'assistant') {
      lines.push(`ZIRON: ${msg.content}`);
    }
    // Skip tool_use, tool_result, summary messages
  }

  return lines.join('\n\n');
}

/**
 * Build the extraction prompt for the LLM
 * @param {string} currentMemory - Current memory index content
 * @param {string} conversationText - Formatted conversation
 * @returns {Object} Prompt object with system and messages
 */
function buildExtractionPrompt(currentMemory, conversationText) {
  const system = `You are ZIRON's memory manager. Your only job is to analyze conversations and extract information worth remembering long-term.

Memory types:
- user: Who Hiro is — role, goals, preferences, habits, background, CRITICAL: EXPLICIT TIMEZONE OFFSET (e.g. GMT+7, UTC-5), locations
- feedback: How ZIRON should behave — what Hiro liked, corrected, or complained about
- project: Ongoing tasks, goals, deadlines, plans Hiro mentioned
- reference: External resources Hiro mentioned (links, tools, services, people)

Rules:
- Only extract genuinely new information not already in current memory
- Be specific and concrete, not vague
- Convert relative dates to absolute (e.g. "next Thursday" → "2026-04-24")
- Return null for a type if nothing new was learned
- If nothing at all is worth saving, return {"nothing": true}`;

  const userPrompt = `Current memory:
${currentMemory || '(No memory yet)'}

---

Recent conversation:
${conversationText}

---

Extract what's worth remembering. Respond ONLY with valid JSON, no markdown, no explanation:
{
  "user": "string or null",
  "feedback": "string or null",
  "project": "string or null",
  "reference": "string or null"
}`;

  return {
    system,
    messages: [
      { role: 'user', content: userPrompt }
    ]
  };
}

/**
 * Parse LLM response and extract memory object
 * @param {Object} response - LLM response from provider.chat()
 * @returns {Object|null} Extracted memory or null
 */
function parseExtractionResponse(response) {
  try {
    // Extract text from response
    let text = '';
    if (response.content && Array.isArray(response.content)) {
      const textBlock = response.content.find(block => block.type === 'text');
      if (textBlock) {
        text = textBlock.text;
      }
    } else if (typeof response.content === 'string') {
      text = response.content;
    }

    if (!text) {
      logger.warn('[Memory] Empty response from LLM');
      return null;
    }

    // Clean markdown code blocks if present
    text = text.trim();
    if (text.startsWith('```json')) {
      text = text.replace(/```json\n?/g, '').replace(/```\n?$/g, '');
    } else if (text.startsWith('```')) {
      text = text.replace(/```\n?/g, '');
    }

    // Parse JSON
    const parsed = JSON.parse(text);

    // Check if nothing to save
    if (parsed.nothing === true) {
      return null;
    }

    // Filter out null/empty values
    const extracted = {};
    let hasContent = false;

    for (const type of ['user', 'feedback', 'project', 'reference']) {
      if (parsed[type] && typeof parsed[type] === 'string' && parsed[type].trim()) {
        extracted[type] = parsed[type].trim();
        hasContent = true;
      }
    }

    return hasContent ? extracted : null;

  } catch (err) {
    logger.error('[Memory] Failed to parse extraction response:', err.message);
    logger.debug('[Memory] Raw response:', JSON.stringify(response, null, 2));
    return null;
  }
}

/**
 * Write extracted memory to files and rebuild index
 * @param {Object} extracted - Extracted memory object with user/feedback/project/reference fields
 * @returns {Promise<void>}
 */
async function writeMemory(extracted) {
  // 1. Ensure memory directory exists
  await fs.mkdir(MEMORY_DIR, { recursive: true, mode: 0o700 });

  // 2. Append to individual memory files
  const timestamp = new Date().toISOString();

  for (const [type, content] of Object.entries(extracted)) {
    const filePath = MEMORY_FILES[type];
    if (!filePath || !content) continue;

    try {
      // Read existing content
      let existing = '';
      try {
        existing = await fs.readFile(filePath, 'utf-8');
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }

      // Build new content with timestamp header
      const entry = `\n## ${timestamp}\n\n${content}\n`;
      const newContent = existing + entry;

      // Atomic write: write to temp file, then rename
      const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      await fs.writeFile(tempPath, newContent, { encoding: 'utf-8', mode: 0o600 });
      await fs.rename(tempPath, filePath);

      logger.debug(`[Memory] Updated ${type}.md`);

    } catch (err) {
      logger.error(`[Memory] Failed to write ${type}.md:`, err.message);
    }
  }

  // 3. Rebuild MEMORY.md index
  await rebuildMemoryIndex();
}

/**
 * Rebuild the MEMORY.md index from individual memory files
 * @returns {Promise<void>}
 */
async function rebuildMemoryIndex() {
  const timestamp = new Date().toISOString();
  const sections = [];

  sections.push('# ZIRON Memory Index');
  sections.push(`Last updated: ${timestamp}`);
  sections.push('');

  // Read preview of each memory file
  for (const [type, filePath] of Object.entries(MEMORY_FILES)) {
    const title = type.charAt(0).toUpperCase() + type.slice(1);
    sections.push(`## ${title}`);
    sections.push('');

    try {
      const content = await fs.readFile(filePath, 'utf-8');
      const preview = content.trim().substring(0, MEMORY_PREVIEW_LENGTH);

      if (preview) {
        sections.push(preview);
        if (content.length > MEMORY_PREVIEW_LENGTH) {
          sections.push('');
          sections.push('*(continued in file...)*');
        }
      } else {
        sections.push('*(empty)*');
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        sections.push('*(empty)*');
      } else {
        logger.error(`[Memory] Failed to read ${type}.md:`, err.message);
        sections.push('*(error reading file)*');
      }
    }

    sections.push('');
  }

  // Write index file atomically
  const indexContent = sections.join('\n');
  const tempPath = `${MEMORY_INDEX_FILE}.${process.pid}.${randomUUID()}.tmp`;

  await fs.writeFile(tempPath, indexContent, { encoding: 'utf-8', mode: 0o600 });
  await fs.rename(tempPath, MEMORY_INDEX_FILE);

  logger.debug('[Memory] Rebuilt MEMORY.md index');
}

// ============================================================================
// Exports
// ============================================================================

export default {
  shouldExtractMemory,
  extractMemory,
};
