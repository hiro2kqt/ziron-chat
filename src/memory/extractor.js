/**
 * Memory Extraction System
 *
 * Every few messages, looks at the messages added since the last extraction
 * and rewrites each memory file as a short, de-duplicated list of durable
 * facts. Files are rewritten (not appended), so contradictions and stale facts
 * get replaced instead of piling up.
 *
 * Files: ~/.ziron/memory/{user,feedback,project,reference}.md
 * Index: ~/.ziron/memory/MEMORY.md (all files concatenated; injected into the system prompt)
 * Cursor: ~/.ziron/memory/.state.json ({ sessions: { [sessionId]: lastMessageId } })
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
const STATE_FILE = path.join(MEMORY_DIR, '.state.json');
const MAX_ITEMS_PER_TYPE = 15;
const MAX_NEW_CONVERSATION_CHARS = 12000; // cap per extraction call

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'];
const MEMORY_FILES = Object.fromEntries(MEMORY_TYPES.map(t => [t, path.join(MEMORY_DIR, `${t}.md`)]));
const TITLES = { user: 'User', feedback: 'Feedback', project: 'Project', reference: 'Reference' };

// ============================================================================
// Public API
// ============================================================================

/**
 * Check if memory extraction should run
 * @param {number} messageCount - Total messages in session
 * @returns {boolean}
 */
export function shouldExtractMemory(messageCount) {
  return messageCount > 0 && messageCount % MEMORY_EXTRACTION_INTERVAL === 0;
}

/**
 * Extract memory from the messages added since the last extraction
 * @param {string} sessionId
 * @param {Object} provider - LLM provider with chat() method
 * @returns {Promise<Object|null>} Rewritten files, or null if nothing changed
 */
export async function extractMemory(sessionId, provider) {
  try {
    const messages = await loadSession(sessionId);
    if (messages.length === 0) return null;

    const state = await loadState();
    const lastId = state.sessions[sessionId];
    const lastIdx = lastId ? messages.findIndex(m => m.id === lastId) : -1;
    const newMessages = messages.slice(lastIdx + 1);
    const conversationText = formatConversation(newMessages);

    // Advance the cursor even if nothing is learned, so the same messages are
    // never sent to the LLM twice
    const advanceCursor = async () => {
      state.sessions[sessionId] = messages[messages.length - 1].id;
      await saveState(state);
    };

    if (!conversationText) {
      await advanceCursor();
      return null;
    }

    logger.info(`[Memory] Extracting from ${newMessages.length} new message(s) in session ${sessionId.substring(0, 8)}...`);

    const current = await loadMemoryFiles();
    const prompt = buildExtractionPrompt(current, conversationText);
    const response = await provider.chat({
      system: prompt.system,
      messages: prompt.messages,
      max_tokens: 3000,
    });

    const updates = parseExtractionResponse(response, current);
    if (updates) {
      await writeMemory(updates);
      logger.success(`[Memory] Rewrote: ${Object.keys(updates).join(', ')}`);
    } else {
      logger.debug('[Memory] Nothing new worth saving');
    }

    await advanceCursor();
    return updates;
  } catch (err) {
    logger.error('[Memory] Extraction failed:', err.message);
    return null;
  }
}

/**
 * Rebuild MEMORY.md from the individual files (also usable after manual edits)
 * @returns {Promise<void>}
 */
export async function rebuildMemoryIndex() {
  const current = await loadMemoryFiles();
  const sections = ['# ZIRON Memory', ''];
  for (const type of MEMORY_TYPES) {
    sections.push(`## ${TITLES[type]}`, '');
    sections.push(current[type].length ? current[type].map(i => `- ${i}`).join('\n') : '*(empty)*');
    sections.push('');
  }
  await atomicWrite(MEMORY_INDEX_FILE, sections.join('\n'));
  logger.debug('[Memory] Rebuilt MEMORY.md');
}

// ============================================================================
// Internals
// ============================================================================

async function loadState() {
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_FILE, 'utf-8'));
    return { sessions: parsed.sessions || {} };
  } catch {
    return { sessions: {} };
  }
}

async function saveState(state) {
  await fs.mkdir(MEMORY_DIR, { recursive: true, mode: 0o700 });
  await atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Read each memory file as a list of bullet items
 * @returns {Promise<Object<string, string[]>>}
 */
async function loadMemoryFiles() {
  const out = {};
  for (const type of MEMORY_TYPES) {
    try {
      const text = await fs.readFile(MEMORY_FILES[type], 'utf-8');
      out[type] = text.split('\n')
        .filter(l => /^\s*-\s+/.test(l))
        .map(l => l.replace(/^\s*-\s+/, '').trim())
        .filter(Boolean);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      out[type] = [];
    }
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(b => b?.type === 'text').map(b => b.text).join('\n');
  }
  return '';
}

/**
 * Only the human-readable turns (no tool calls/results), newest kept if long
 * @param {Array} messages
 * @returns {string}
 */
function formatConversation(messages) {
  const lines = [];
  for (const msg of messages) {
    if (msg.compactCopy) continue; // already seen before compaction
    const text = textOf(msg.content).trim();
    if (!text) continue;
    if (msg.role === 'user') lines.push(`Hiro: ${text}`);
    else if (msg.role === 'assistant') lines.push(`ZIRON: ${text}`);
  }
  const joined = lines.join('\n\n');
  return joined.length > MAX_NEW_CONVERSATION_CHARS
    ? joined.slice(-MAX_NEW_CONVERSATION_CHARS)
    : joined;
}

function buildExtractionPrompt(current, conversationText) {
  const system = `You are ZIRON's memory manager. You maintain four short lists of durable facts about Hiro.

Types:
- user: who Hiro is — background, location, relationships, habits, preferences.
- feedback: how ZIRON should behave — what Hiro liked, corrected or complained about.
- project: long-running personal goals or projects (weeks to months).
- reference: external resources Hiro relies on (tools, services, links, people to contact).

NEVER store:
- reminders, schedules, alarms, one-off tasks or dates of specific events — the scheduler database is the source of truth for those;
- timezone offsets (GMT+N) — the system config provides the current timezone;
- university course or module details, lecture or exam information — the email system handles those;
- anything from the conversation that is temporary or already done.

For each type, decide whether the NEW conversation changes the list:
- If not, return null for that type.
- If yes, return the COMPLETE rewritten list: keep every still-valid existing item, merge duplicates,
  replace items that the new conversation contradicts, drop outdated ones, add new durable facts.
  Max ${MAX_ITEMS_PER_TYPE} items, each one concise sentence in English.`;

  const fmt = items => (items.length ? items.map(i => `- ${i}`).join('\n') : '(empty)');
  const user = `Current memory:
${MEMORY_TYPES.map(t => `## ${t}\n${fmt(current[t])}`).join('\n\n')}

---

New conversation since the last update:
${conversationText}

---

Respond ONLY with JSON, no markdown:
{"user": [..] or null, "feedback": [..] or null, "project": [..] or null, "reference": [..] or null}`;

  return { system, messages: [{ role: 'user', content: user }] };
}

/**
 * @returns {Object<string, string[]>|null} only the types that changed
 */
function parseExtractionResponse(response, current) {
  let text = Array.isArray(response?.content)
    ? textOf(response.content)
    : (typeof response?.content === 'string' ? response.content : '');
  text = (text || '').trim();
  if (!text) {
    logger.warn('[Memory] Empty response from LLM');
    return null;
  }
  const m = text.match(/\{[\s\S]*\}/);
  let parsed;
  try {
    parsed = JSON.parse(m ? m[0] : text);
  } catch (err) {
    logger.error('[Memory] Failed to parse extraction response:', err.message);
    return null;
  }

  const updates = {};
  for (const type of MEMORY_TYPES) {
    const v = parsed[type];
    if (!Array.isArray(v)) continue;
    const items = [...new Set(v.map(s => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean))]
      .slice(0, MAX_ITEMS_PER_TYPE);
    // Guard against a model that "rewrites" a non-empty list into nothing
    if (items.length === 0 && current[type].length > 0) continue;
    if (JSON.stringify(items) === JSON.stringify(current[type])) continue;
    updates[type] = items;
  }
  return Object.keys(updates).length ? updates : null;
}

async function writeMemory(updates) {
  await fs.mkdir(MEMORY_DIR, { recursive: true, mode: 0o700 });
  for (const [type, items] of Object.entries(updates)) {
    const body = `# ${TITLES[type]}\n\n${items.map(i => `- ${i}`).join('\n')}\n`;
    try {
      await atomicWrite(MEMORY_FILES[type], body);
    } catch (err) {
      logger.error(`[Memory] Failed to write ${type}.md:`, err.message);
    }
  }
  await rebuildMemoryIndex();
}

async function atomicWrite(filePath, content) {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tempPath, content, { encoding: 'utf-8', mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

// ============================================================================
// Exports
// ============================================================================

export default {
  shouldExtractMemory,
  extractMemory,
  rebuildMemoryIndex,
};
