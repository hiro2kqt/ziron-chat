/**
 * Test OpenRouter integration
 * Standalone command for testing
 */

import { loadConfig } from '../config/index.js';
import { chat } from '../providers/openrouter.js';
import logger from '../utils/logger.js';

export async function testOpenRouterCommand() {
  logger.info('🧪 Testing OpenRouter integration\n');

  const config = loadConfig();

  if (!config.openrouter.apiKey) {
    logger.error('Missing OpenRouter API key');
    logger.info('Run: ziron onboarding');
    process.exit(1);
  }

  try {
    logger.info('Sending test prompt to OpenRouter...');
    const prompt = 'Say "Hello from Ziron!" in one sentence.';

    const response = await chat(prompt, config.openrouter.apiKey, {
      model: 'anthropic/claude-3.5-sonnet',
      maxTokens: 100,
    });

    logger.success('Response received:\n');
    console.log(response);
    console.log();
    logger.success('OpenRouter integration working!');

  } catch (err) {
    logger.error('OpenRouter test failed:', err.message);
    process.exit(1);
  }
}

export default { testOpenRouterCommand };
