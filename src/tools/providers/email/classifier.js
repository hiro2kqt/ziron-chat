/**
 * Email Classifier
 * Uses existing LLM provider to classify email importance
 */

import { chat } from '../../../providers/openrouter.js';
import { loadConfig } from '../../../config/index.js';
import logger from '../../../utils/logger.js';

/**
 * Classify if an email is important
 * @param {Object} email - Email data
 * @param {string} email.subject - Email subject
 * @param {string} email.from - Sender email/name
 * @param {string} email.snippet - Email content preview
 * @returns {Promise<Object>} Classification result
 * @property {boolean} important - Whether email is important
 * @property {string} reason - Why it's important/not important
 * @property {string} category - Category (deadline, exam, assignment, announcement, other)
 */
export async function classifyEmail(email) {
  const config = loadConfig();
  const apiKey = config.providers?.openrouter?.apiKey;

  // Fix 3: surface missing API key — do not swallow, let gateway handle it
  if (!apiKey) {
    throw new Error('OpenRouter API key required for email classification');
  }

  const { subject, from } = email;

  // Fix 4: explicit placeholder when snippet is empty so the model knows
  const snippet = email.snippet?.trim() || '(no content available)';

  // Fix 2: improved prompt — language-aware, tighter category boundaries,
  //         tiebreaker rules, no markdown fences in response
  const prompt = `You are an email classifier for a university student at TU Dortmund.
The emails may be written in German or English — always respond in English.

Classify if this email is IMPORTANT based on these categories:

IMPORTANT — classify as one of:
- "deadline": A specific due date is mentioned (registration, payment, form submission).
  Do NOT use this for assignment submissions — use "assignment" instead.
- "exam": Anything about exams (schedule, location, results, registration).
- "assignment": New assignment released, submission due, or clarification about coursework.
- "announcement": Official course or university update (room change, lecture cancelled, grade released, new course material).

NOT IMPORTANT — classify as "other":
- Marketing, newsletters, social notifications, automated system emails with no action required.

Tiebreaker rules:
- If an email mentions both a deadline AND an assignment → use "assignment"
- If unsure between announcement and other → prefer "other"

From: ${from}
Subject: ${subject}
Content: ${snippet}

Respond ONLY with valid JSON, no markdown fences, no explanation outside the JSON:
{
  "important": true or false,
  "reason": "one sentence in English explaining why",
  "category": "deadline/exam/assignment/announcement/other"
}`;

  try {
    const content = await chat(prompt, apiKey, {
      model: config.providers?.openrouter?.model,
      maxTokens: 400, // Fix 1: raised from 200 to prevent mid-JSON truncation
      temperature: 0.3,
    });

    if (!content) {
      throw new Error('No response from classifier');
    }

    // Fix 3: log raw content on parse failure so it's visible in terminal
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Fix 2: prompt asks for no fences, but defensively try extracting anyway
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn('[Email Classifier] Could not extract JSON. Raw response:\n', content);
        return {
          important: false,
          reason: 'Failed to parse classifier response',
          category: 'other',
        };
      }
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        logger.warn('[Email Classifier] JSON.parse failed. Raw response:\n', content);
        return {
          important: false,
          reason: 'Failed to parse classifier response',
          category: 'other',
        };
      }
    }

    logger.debug('[Email Classifier] Result:', parsed);

    return {
      important: parsed.important || false,
      reason:    parsed.reason    || '',
      category:  parsed.category  || 'other',
    };

  } catch (err) {
    // Fix 3: re-throw API-level errors (network, auth, rate limit) so the
    //         caller (monitor.js) can decide whether to skip or abort the batch.
    //         Only genuine parse failures above return a safe default.
    logger.error('[Email Classifier] Error:', err.message);
    throw err;
  }
}

export default { classifyEmail };
