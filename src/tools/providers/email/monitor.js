/**
 * Email Monitor
 * Fetches new emails and classifies them
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import EmailState from '../../../db/models/EmailState.js';
import Email from '../../../db/models/Email.js';
import { classifyEmail } from './classifier.js';
import logger from '../../../utils/logger.js';

/**
 * Process a batch of emails (fetch, parse, classify, save)
 * @param {ImapFlow} client - Connected IMAP client
 * @param {string} range - UID range to fetch (e.g., "1:50")
 * @param {string} mailbox - Mailbox name
 * @returns {Promise<Object>} { processedCount, highestUID, importantEmails }
 */
async function processBatch(client, range, mailbox) {
  const emails = [];
  let highestUID = 0;

  for await (const msg of client.fetch(range, { source: true })) {
    try {
      const parsed = await simpleParser(msg.source);

      const emailData = {
        uid: msg.uid,
        subject: parsed.subject || '(no subject)',
        from: parsed.from?.text || '',
        date: parsed.date?.toISOString() || '',
        snippet: (parsed.text || parsed.html || '')
          .replace(/<[^>]+>/g, '')
          .trim()
          .slice(0, 300),
      };

      emails.push(emailData);

      if (msg.uid > highestUID) {
        highestUID = msg.uid;
      }

    } catch (parseErr) {
      logger.error(`[Email Monitor] Failed to parse email UID ${msg.uid}:`, parseErr.message);
    }
  }

  // Classify and save each email
  const importantEmails = [];

  for (const email of emails) {
    logger.debug(`[Email Monitor] Classifying: ${email.subject}`);

    const classification = await classifyEmail({
      subject: email.subject,
      from: email.from,
      snippet: email.snippet,
    });

    // Save to MongoDB
    try {
      await Email.findOneAndUpdate(
        { mailbox, uid: email.uid },
        {
          uid: email.uid,
          mailbox,
          subject: email.subject,
          from: email.from,
          date: new Date(email.date),
          snippet: email.snippet,
          important: classification.important,
          category: classification.category,
          summary: classification.reason,
        },
        { upsert: true, new: true }
      );
      logger.debug(`[Email Monitor] Saved email UID ${email.uid} to MongoDB`);
    } catch (saveErr) {
      logger.error(`[Email Monitor] Failed to save email UID ${email.uid}:`, saveErr.message);
    }

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

  return {
    processedCount: emails.length,
    highestUID,
    importantEmails,
  };
}

/**
 * Perform initial full sync of all emails
 * @param {ImapFlow} client - Connected IMAP client
 * @param {Object} lock - Mailbox lock
 * @param {string} mailbox - Mailbox name
 * @param {number} totalMessages - Total number of messages in mailbox
 * @returns {Promise<number>} Highest UID processed
 */
async function performFullSync(client, lock, mailbox, totalMessages) {
  logger.info(`[Email Monitor] 🔄 Starting initial full sync (${totalMessages} emails)...`);

  const BATCH_SIZE = 50;
  let currentUID = 1;
  let highestUID = 0;
  let totalProcessed = 0;
  let totalImportant = 0;

  while (currentUID <= totalMessages) {
    const endUID = Math.min(currentUID + BATCH_SIZE - 1, totalMessages);
    const range = `${currentUID}:${endUID}`;

    logger.info(`[Email Monitor] Processing batch: UIDs ${range} (${totalProcessed}/${totalMessages})`);

    try {
      const { processedCount, highestUID: batchHighestUID, importantEmails } =
        await processBatch(client, range, mailbox);

      totalProcessed += processedCount;
      totalImportant += importantEmails.length;

      if (batchHighestUID > highestUID) {
        highestUID = batchHighestUID;
      }

      // Update lastSeenUID after each batch to track progress
      await EmailState.findOneAndUpdate(
        { mailbox },
        {
          lastSeenUID: highestUID,
          lastCheckedAt: new Date(),
        }
      );

      logger.info(`[Email Monitor] Batch complete: ${processedCount} processed, ${importantEmails.length} important`);

    } catch (batchErr) {
      logger.error(`[Email Monitor] Batch ${range} failed:`, batchErr.message);
      // Continue with next batch even if this one fails
    }

    currentUID = endUID + 1;
  }

  logger.success(`[Email Monitor] ✅ Full sync complete: ${totalProcessed} emails, ${totalImportant} important`);

  return highestUID;
}

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

      // Check if this is first run (never synced before)
      if (lastSeenUID === 0 && status.messages > 0) {
        logger.info(`[Email Monitor] 🆕 First run detected - performing full sync`);

        const highestUID = await performFullSync(client, lock, mailbox, status.messages);

        logger.success(`[Email Monitor] Initial sync complete - now in normal polling mode`);

        // Return empty array for first sync (don't notify about old emails)
        return [];
      }

      // Normal polling mode: fetch only new emails
      const searchCriteria = { uid: `${lastSeenUID + 1}:*` };

      logger.info(`[Email Monitor] Fetching new emails (UID > ${lastSeenUID})`);

      const { processedCount, highestUID, importantEmails } =
        await processBatch(client, searchCriteria.uid, mailbox);

      logger.info(`[Email Monitor] Found ${processedCount} new email(s)`);

      if (processedCount === 0) {
        // Update last checked time even if no new emails
        await EmailState.findOneAndUpdate(
          { mailbox },
          { lastCheckedAt: new Date() }
        );
        return [];
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
