/**
 * Email Monitor
 * Fetches new emails and classifies them
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import EmailState from '../../../db/models/EmailState.js';
import { classifyEmail } from './classifier.js';
import logger from '../../../utils/logger.js';

/**
 * Check for new emails and classify important ones
 * @param {Object} imapConfig - IMAP connection config
 * @param {string} imapConfig.host - IMAP host
 * @param {number} imapConfig.port - IMAP port
 * @param {string} imapConfig.user - IMAP username
 * @param {string} imapConfig.pass - IMAP password
 * @param {string} [mailbox='INBOX'] - Mailbox to check
 * @returns {Promise<Array>} Array of important emails with classification
 */
export async function checkNewEmails(imapConfig, mailbox = 'INBOX') {
  const { host, port, user, pass } = imapConfig;

  if (!host || !user || !pass) {
    throw new Error('IMAP configuration incomplete (host, user, pass required)');
  }

  logger.info(`[Email Monitor] Checking ${mailbox} for new emails...`);

  // Get last seen UID from database
  let state = await EmailState.findOne({ mailbox });

  if (!state) {
    // First time, create state with UID 0
    state = await EmailState.create({
      mailbox,
      lastSeenUID: 0,
      lastCheckedAt: null,
    });
    logger.info(`[Email Monitor] First check for ${mailbox}, starting from UID 0`);
  }

  const lastSeenUID = state.lastSeenUID;
  logger.debug(`[Email Monitor] Last seen UID: ${lastSeenUID}`);

  // Connect to IMAP
  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass },
    logger: false,
  });

  try {
    await client.connect();
    logger.debug(`[Email Monitor] Connected to ${host}`);

    const lock = await client.getMailboxLock(mailbox);

    try {
      const status = await client.status(mailbox, { messages: true, uidNext: true });
      logger.debug(`[Email Monitor] Mailbox status:`, status);

      // Fetch emails with UID > lastSeenUID
      const searchCriteria = { uid: `${lastSeenUID + 1}:*` };
      const fetchOptions = { source: true };

      const emails = [];
      let highestUID = lastSeenUID;

      for await (const msg of client.fetch(searchCriteria, fetchOptions)) {
        try {
          const parsed = await simpleParser(msg.source);

          const emailData = {
            uid: msg.uid,
            subject: parsed.subject || '(no subject)',
            from: parsed.from?.text || '',
            date: parsed.date?.toISOString() || '',
            snippet: (parsed.text || parsed.html || '')
              .replace(/<[^>]+>/g, '') // strip HTML
              .trim()
              .slice(0, 300),
          };

          emails.push(emailData);

          // Track highest UID
          if (msg.uid > highestUID) {
            highestUID = msg.uid;
          }

        } catch (parseErr) {
          logger.error(`[Email Monitor] Failed to parse email UID ${msg.uid}:`, parseErr.message);
        }
      }

      logger.info(`[Email Monitor] Found ${emails.length} new email(s)`);

      if (emails.length === 0) {
        // Update last checked time even if no new emails
        await EmailState.findOneAndUpdate(
          { mailbox },
          { lastCheckedAt: new Date() }
        );
        return [];
      }

      // Classify each email
      const importantEmails = [];

      for (const email of emails) {
        logger.debug(`[Email Monitor] Classifying: ${email.subject}`);

        const classification = await classifyEmail({
          subject: email.subject,
          from: email.from,
          snippet: email.snippet,
        });

        if (classification.important) {
          importantEmails.push({
            ...email,
            classification,
          });
          logger.info(`[Email Monitor] ⚠️  Important: ${email.subject} (${classification.category})`);
        } else {
          logger.debug(`[Email Monitor] Not important: ${email.subject}`);
        }
      }

      // Update state with highest UID seen
      await EmailState.findOneAndUpdate(
        { mailbox },
        {
          lastSeenUID: highestUID,
          lastCheckedAt: new Date(),
        }
      );

      logger.success(`[Email Monitor] Check complete. ${importantEmails.length} important email(s)`);

      return importantEmails;

    } finally {
      lock.release();
    }

  } catch (err) {
    logger.error(`[Email Monitor] Error:`, err.message);
    throw err;
  } finally {
    await client.logout();
  }
}

export default { checkNewEmails };
