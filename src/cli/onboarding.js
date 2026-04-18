/**
 * Onboarding command
 * Interactive setup flow that generates config.json
 */

import { loadConfig, saveConfig, configExists, getConfigPath } from '../config/index.js';
import { validateApiKey as validateOpenRouterKey } from '../providers/openrouter.js';
import { validateApiKey as validateOpenAIKey } from '../providers/openai.js';
import { validateBotToken } from '../channels/telegram/index.js';
import logger from '../utils/logger.js';

export async function onboardingCommand(options = {}) {
  logger.info('🚀 Welcome to Ziron onboarding!\n');

  const config = loadConfig();
  const hasConfigFile = configExists();

  if (hasConfigFile) {
    logger.info(`Found existing config: ${getConfigPath()}\n`);
  }

  let anyValid = false;

  // Check OpenRouter
  logger.info('Checking OpenRouter configuration...');
  let openrouterValid = false;

  if (!config.providers.openrouter.apiKey) {
    logger.warn('  ✗ OpenRouter API key not found');
    logger.info('  → Get your key from: https://openrouter.ai/settings/keys');
    logger.info('  → Add to .env: OPENROUTER_API_KEY=your_key_here\n');
  } else {
    logger.info('  API key found, testing connection...');
    openrouterValid = await validateOpenRouterKey(config.providers.openrouter.apiKey);

    if (openrouterValid) {
      logger.success('  ✓ OpenRouter connection successful\n');
      anyValid = true;
    } else {
      logger.warn('  ✗ OpenRouter API key invalid or connection failed');
      logger.info('  → Check your API key at: https://openrouter.ai/settings/keys\n');
    }
  }

  // Check OpenAI
  logger.info('Checking OpenAI configuration...');
  let openaiValid = false;

  if (!config.providers.openai.apiKey && !config.providers.openai.oauth.accessToken) {
    logger.warn('  ✗ OpenAI credentials not found');
    logger.info('  → Option 1: Add API key to .env: OPENAI_API_KEY=your_key');
    logger.info('  → Option 2: Run OAuth login: ziron auth openai-oauth\n');
  } else if (config.providers.openai.apiKey) {
    logger.info('  API key found, testing connection...');
    openaiValid = await validateOpenAIKey(config.providers.openai.apiKey);

    if (openaiValid) {
      logger.success('  ✓ OpenAI connection successful\n');
      anyValid = true;
    } else {
      logger.warn('  ✗ OpenAI API key invalid or connection failed\n');
    }
  } else if (config.providers.openai.oauth.accessToken) {
    logger.success(`  ✓ OpenAI OAuth configured (${config.providers.openai.oauth.email})\n`);
    openaiValid = true;
    anyValid = true;
  }

  // Check Telegram
  logger.info('Checking Telegram bot configuration...');
  let telegramValid = false;

  if (!config.telegram.botToken) {
    logger.warn('  ✗ Telegram bot token not found');
    logger.info('  → Create a bot with @BotFather on Telegram');
    logger.info('  → Add to .env: TELEGRAM_BOT_TOKEN=your_token\n');
  } else {
    logger.info('  Bot token found, validating...');
    const botInfo = await validateBotToken(config.telegram.botToken);

    if (botInfo) {
      logger.success(`  ✓ Bot token valid: @${botInfo.username}`);
      telegramValid = true;
    } else {
      logger.warn('  ✗ Invalid bot token');
      logger.info('  → Check your token from @BotFather\n');
    }
  }

  // Summary
  logger.info('📋 Setup Summary:');
  logger.info(`  OpenRouter: ${openrouterValid ? '✓ Ready' : '✗ Missing or Invalid'}`);
  logger.info(`  OpenAI:     ${openaiValid ? '✓ Ready' : '✗ Missing or Invalid'}`);
  logger.info(`  Telegram:   ${telegramValid ? '✓ Ready' : '✗ Missing or Invalid'}\n`);

  // Save config if we have any valid credentials
  if ((anyValid || telegramValid) && !hasConfigFile) {
    logger.info('Generating config.json...');
    saveConfig(config);
    logger.success('✓ Config saved to config.json\n');
  }

  // Next steps
  if ((openrouterValid || openaiValid) && telegramValid) {
    logger.success('✅ All configured! Run: ziron telegram connect');
  } else {
    logger.info('Next steps:');
    if (!anyValid) {
      logger.info('  1. Get credentials:');
      logger.info('     - OpenRouter: https://openrouter.ai/settings/keys');
      logger.info('     - OpenAI: https://platform.openai.com/api-keys');
    }
    if (!telegramValid) {
      logger.info('  2. Create Telegram bot: @BotFather');
    }
    logger.info('  3. Add to .env file');
    logger.info('  4. Run: ziron onboarding (to verify)');
    logger.info('  5. Run: ziron telegram connect');
  }
}

export default { onboardingCommand };
