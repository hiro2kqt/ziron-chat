/**
 * IMAP IDLE watcher
 * Keeps one connection open on INBOX; the server pushes an EXISTS update as
 * soon as new mail lands, and we call onNewMail() within seconds instead of
 * waiting for the next poll. Reconnects with backoff if the link drops.
 */

import { ImapFlow } from 'imapflow';
import logger from '../../../utils/logger.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * @param {Object} imapConfig - { host, port, user, pass }
 * @param {Function} onNewMail - called (no args) when the mailbox grows
 * @param {string} [mailbox='INBOX']
 * @returns {Function} stop()
 */
export function startIdleWatcher(imapConfig, onNewMail, mailbox = 'INBOX') {
  let stopped = false;
  let client = null;

  (async () => {
    let backoff = 5000;
    while (!stopped) {
      try {
        client = new ImapFlow({
          host: imapConfig.host,
          port: imapConfig.port || 993,
          secure: true,
          auth: { user: imapConfig.user, pass: imapConfig.pass },
          logger: false,
          // Re-issue IDLE periodically; servers drop long idles (~30 min)
          maxIdleTime: 5 * 60 * 1000,
        });
        client.on('error', err => logger.warn('[Email IDLE] Connection error:', err.message));
        client.on('exists', data => {
          if (data.count > (data.prevCount ?? 0)) {
            logger.info(`[Email IDLE] New mail in ${mailbox} (${data.prevCount} -> ${data.count})`);
            onNewMail();
          }
        });

        await client.connect();
        await client.mailboxOpen(mailbox, { readOnly: true });
        logger.success(`[Email IDLE] Watching ${mailbox} (push mode)`);
        backoff = 5000;

        // Catch anything that arrived while we were disconnected
        onNewMail();

        // imapflow idles automatically while no command runs; wait for close
        await new Promise(resolve => client.once('close', resolve));
        if (!stopped) logger.warn('[Email IDLE] Connection closed, reconnecting...');
      } catch (err) {
        logger.warn('[Email IDLE] Failed:', err.message);
      }
      if (stopped) break;
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 5 * 60 * 1000);
    }
  })();

  return () => {
    stopped = true;
    client?.logout().catch(() => client?.close());
  };
}

export default { startIdleWatcher };
