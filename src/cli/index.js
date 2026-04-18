/**
 * CLI Program Definition
 * Uses Commander for routing
 */

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '../..');

// Read package.json for version
const pkg = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'));

/**
 * Build the CLI program
 * @returns {Command}
 */
export function buildProgram() {
  const program = new Command();

  program
    .name('ziron')
    .description('Minimal AI assistant - Telegram + OpenRouter')
    .version(pkg.version);

  // Register command groups
  registerOnboardingCommand(program);
  registerConfigCommands(program);
  registerAuthCommands(program);
  registerTelegramCommands(program);
  registerTestCommands(program);

  return program;
}

/**
 * Register onboarding command
 */
function registerOnboardingCommand(program) {
  program
    .command('onboarding')
    .alias('onboard')
    .description('Interactive setup for Ziron')
    .action(async () => {
      const { onboardingCommand } = await import('./onboarding.js');
      await onboardingCommand();
    });
}

/**
 * Register config commands
 */
function registerConfigCommands(program) {
  const config = program
    .command('config')
    .description('Manage configuration');

  config
    .command('show')
    .description('Show current configuration')
    .action(async () => {
      const { showConfigCommand } = await import('./config.js');
      await showConfigCommand();
    });

  config
    .command('get <key>')
    .description('Get a config value')
    .action(async (key) => {
      const { getConfigCommand } = await import('./config.js');
      await getConfigCommand(key);
    });

  config
    .command('set <key> <value>')
    .description('Set a config value')
    .action(async (key, value) => {
      const { setConfigCommand } = await import('./config.js');
      await setConfigCommand(key, value);
    });
}

/**
 * Register auth commands
 */
function registerAuthCommands(program) {
  const auth = program
    .command('auth')
    .description('Authentication commands');

  auth
    .command('openai-oauth')
    .description('Login to OpenAI via OAuth')
    .action(async () => {
      const { openaiOAuthCommand } = await import('./auth.js');
      await openaiOAuthCommand();
    });
}

/**
 * Register test commands
 */
function registerTestCommands(program) {
  program
    .command('test-openrouter')
    .description('Test OpenRouter API connection')
    .action(async () => {
      const { testOpenRouterCommand } = await import('./test-openrouter.js');
      await testOpenRouterCommand();
    });
}

/**
 * Register telegram command group
 */
function registerTelegramCommands(program) {
  const telegram = program
    .command('telegram')
    .alias('tg')
    .description('Telegram integration commands');

  telegram
    .command('connect')
    .description('Connect to Telegram')
    .action(async () => {
      const { connectCommand } = await import('./telegram.js');
      await connectCommand();
    });

  telegram
    .command('status')
    .description('Check Telegram connection status')
    .action(async () => {
      const { statusCommand } = await import('./telegram.js');
      await statusCommand();
    });

  telegram
    .command('test')
    .description('Test Telegram + OpenRouter integration')
    .action(async () => {
      const { testCommand } = await import('./telegram.js');
      await testCommand();
    });
}

export default { buildProgram };
