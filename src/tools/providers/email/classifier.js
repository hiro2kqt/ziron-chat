/**
 * Email Classifier
 * Uses Claude API to classify email importance
 */

import Anthropic from '@anthropic-ai/sdk';
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

  if (!apiKey) {
    throw new Error('OpenRouter API key required for email classification');
  }

  const { subject, from, snippet } = email;

  // Use Claude via OpenRouter
  const prompt = `You are an email classifier for a university student. Classify if this email is IMPORTANT.

IMPORTANT emails are those related to university matters:
- Deadlines (assignment due dates, registration deadlines, etc.)
- Exams (schedules, locations, results)
- Assignments (new assignments, clarifications, submissions)
- Announcements (course updates, schedule changes, university events)

NOT IMPORTANT:
- Marketing emails
- Social notifications
- Newsletters
- General spam

EMAIL TO CLASSIFY:
From: ${from}
Subject: ${subject}
Content: ${snippet}

Respond in JSON format:
{
  "important": true/false,
  "reason": "brief explanation why",
  "category": "deadline/exam/assignment/announcement/other"
}`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/yourusername/ziron',
        'X-Title': 'Ziron Email Classifier',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-3.5-sonnet',
        messages: [
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        max_tokens: 200,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenRouter API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    const content = data.choices[0]?.message?.content;

    if (!content) {
      throw new Error('No response from classifier');
    }

    // Extract JSON from response (might be wrapped in markdown)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('[Email Classifier] Could not parse JSON response:', content);
      return {
        important: false,
        reason: 'Failed to parse classifier response',
        category: 'other',
      };
    }

    const result = JSON.parse(jsonMatch[0]);
    logger.debug('[Email Classifier] Result:', result);

    return {
      important: result.important || false,
      reason: result.reason || '',
      category: result.category || 'other',
    };

  } catch (err) {
    logger.error('[Email Classifier] Error:', err.message);
    // Default to not important on error to avoid spamming
    return {
      important: false,
      reason: `Classification error: ${err.message}`,
      category: 'other',
    };
  }
}

export default { classifyEmail };
