/**
 * Authentication commands
 * OAuth flows for providers
 */

import { intro, outro, text, confirm, spinner } from '@clack/prompts';
import { updateConfig } from '../config/index.js';
import { runOAuthFlow } from '../providers/openai-oauth.js';
import logger from '../utils/logger.js';

/**
 * OpenAI Codex OAuth command
 */
export async function openaiOAuthCommand(options = {}) {
  intro('OpenAI Codex OAuth');

  // Check if running remotely
  const isRemote = process.env.SSH_CONNECTION ||
                   process.env.SSH_CLIENT ||
                   options.remote ||
                   false;

  if (isRemote) {
    logger.info('');
    logger.info('◇  OpenAI Codex OAuth ─────────────────────────────────────────╮');
    logger.info('│                                                              │');
    logger.info('│  You are running in a remote/VPS environment.                │');
    logger.info('│  A URL will be shown for you to open in your LOCAL browser.  │');
    logger.info('│  After signing in, paste the redirect URL back here.         │');
    logger.info('│                                                              │');
    logger.info('├──────────────────────────────────────────────────────────────╯');
    logger.info('│');
  } else {
    logger.info('');
    logger.info('Browser will open for OpenAI authentication.');
    logger.info('If the callback doesn\'t auto-complete, paste the redirect URL.');
    logger.info('OpenAI OAuth uses localhost:1455 for the callback.');
    logger.info('');
  }

  try {
    const s = spinner();
    s.start('Starting OAuth flow...');

    // Run OAuth flow
    const credentials = await runOAuthFlow({ isRemote });

    s.stop('✓ OAuth complete');

    logger.info('');
    logger.success('Authentication successful!');
    logger.info(`Email: ${credentials.email}`);
    logger.info('');

    // Ask to save
    const shouldSave = await confirm({
      message: 'Save credentials to config.json?',
      initialValue: true,
    });

    if (shouldSave) {
      // Update config
      updateConfig({
        providers: {
          openai: {
            model: 'gpt-5.4',  // Set default Codex model for OAuth users
            oauth: {
              accessToken: credentials.accessToken,
              refreshToken: credentials.refreshToken,
              expiresAt: credentials.expiresAt,
              email: credentials.email,
            },
          },
        },
      });

      logger.success('✓ Credentials saved to config.json');
      logger.info('');
      logger.info('You can now use OpenAI Codex models:');
      logger.info('  - gpt-5.4');
      logger.info('  - gpt-5.4-mini');
      logger.info('  - gpt-5.3-codex');
    }

    outro('Done!');

    // Force exit after successful completion
    process.exit(0);

  } catch (err) {
    logger.error('OAuth failed:', err.message);
    logger.info('');
    logger.info('Troubleshooting:');
    logger.info('  - Make sure port 1455 is not in use');
    logger.info('  - Check your internet connection');
    logger.info('  - Try again with: ziron auth openai-oauth');
    process.exit(1);
  }
}

export default { openaiOAuthCommand };
