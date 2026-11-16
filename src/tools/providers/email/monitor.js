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
 * @param {string} uidList - UID list to fetch (e.g., "1,5,10" or "1:50")
 * @param {string} mailbox - Mailbox name
 * @returns {Promise<Object>} { processedCount, highestUID, importantEmails }
 */
// Only notify for mail this recent; older backlog (e.g. after downtime) is
// saved for querying but not pushed, so a restart can't flood Telegram.
const NOTIFY_MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;
// Enough for headers + the text body; skips downloading big attachments.
const SOURCE_MAX_BYTES = 64 * 1024;

async function processBatch(client, uidList, mailbox, minUID = 0) {
  const emails = [];
  let highestUID = 0;

  for await (const msg of client.fetch(uidList, { source: { maxLength: SOURCE_MAX_BYTES }, uid: true }, { uid: true })) {
    // IMAP quirk: "N:*" with N > max UID still returns the newest message,
    // so every idle poll used to re-fetch and re-classify it.
    if (msg.uid <= minUID) continue;
    try {
      const parsed = await simpleParser(msg.source);

      const emailData = {
        uid: msg.uid,
        subject: parsed.subject || '(no subject)',
        from: parsed.from?.text || '',
        date: parsed.date?.toISOString() || '',
        snippet: (parsed.text || parsed.html || '')
          .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          // Bilingual faculty mails put the German text first; deadlines can
          // sit past 1500 chars, so give the classifier more of the body
          .slice(0, 6000),
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
    if (await Email.exists({ mailbox, uid: email.uid })) {
      logger.debug(`[Email Monitor] UID ${email.uid} already processed, skipping`);
      continue;
    }

    logger.debug(`[Email Monitor] Classifying: ${email.subject}`);

    const classification = await classifyEmail({
      subject: email.subject,
      from: email.from,
      date: email.date,
      snippet: email.snippet,
    });

    // Save to MongoDB
    let alreadyExisted = false;
    try {
      const upsertResult = await Email.findOneAndUpdate(
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
          summary: classification.summary,
          deadline: classification.deadline,
          reason: classification.reason,
        },
        { upsert: true, includeResultMetadata: true }
      );
      alreadyExisted = upsertResult.lastErrorObject?.updatedExisting === true;
      logger.debug(`[Email Monitor] Saved email UID ${email.uid} to MongoDB (alreadyExisted: ${alreadyExisted})`);
    } catch (saveErr) {
      logger.error(`[Email Monitor] Failed to save email UID ${email.uid}:`, saveErr.message);
    }

    const ageMs = Date.now() - new Date(email.date).getTime();
    const fresh = !(ageMs > NOTIFY_MAX_AGE_MS);

    if (classification.important && !alreadyExisted && !fresh) {
      logger.info(`[Email Monitor] Important but stale (${Math.round(ageMs / 3600000)}h old), saved without notifying: ${email.subject}`);
    } else if (classification.important && !alreadyExisted) {
      importantEmails.push({
        ...email,
        classification,
      });
      logger.info(`[Email Monitor] ⚠️  Important: ${email.subject} (${classification.category})`);
    } else if (classification.important && alreadyExisted) {
      logger.debug(`[Email Monitor] Skipping notification for already-processed UID ${email.uid}: ${email.subject}`);
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
 * @param {string} [startDate] - Optional start date filter (ISO string)
 * @returns {Promise<number>} Highest UID processed
 */
async function performFullSync(client, lock, mailbox, totalMessages, startDate = null) {
  let searchCriteria = { all: true };
  let logMessage = `[Email Monitor] 🔄 Starting initial full sync (${totalMessages} emails)...`;

  // If no startDate provided, default to 7 days ago to prevent fetching entire inbox
  if (!startDate) {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    startDate = sevenDaysAgo.toISOString().split('T')[0];
    logger.info(`[Email Monitor] No startDate provided, defaulting to ${startDate} (7 days ago)`);
  }

  // If startDate is provided, use IMAP SEARCH to filter at server level
  if (startDate) {
    let sinceDate = new Date(startDate);
    
    // Fallback to 7 days if invalid date
    if (isNaN(sinceDate.getTime())) {
      logger.warn(`[Email Monitor] Invalid startDate: ${startDate}. Defaulting to 7 days ago.`);
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
      startDate = sevenDaysAgo.toISOString().split('T')[0];
      sinceDate = new Date(startDate);
    }
    
    searchCriteria = { since: sinceDate };
    logMessage = `[Email Monitor] 🔄 Starting initial sync (emails since ${startDate})...`;
  }

  logger.info(logMessage);

  // Search for UIDs matching criteria
  const uids = await client.search(searchCriteria, { uid: true });

  if (!uids || uids.length === 0) {
    logger.info('[Email Monitor] No emails found matching criteria');
    return 0;
  }

  logger.info(`[Email Monitor] Found ${uids.length} emails to sync`);

  const BATCH_SIZE = 50;
  let highestUID = 0;
  let totalProcessed = 0;
  let totalImportant = 0;

  // Process UIDs in batches
  for (let i = 0; i < uids.length; i += BATCH_SIZE) {
    const batchUIDs = uids.slice(i, Math.min(i + BATCH_SIZE, uids.length));
    
    logger.info(`[Email Monitor] Processing batch: ${batchUIDs.length} UIDs (${totalProcessed}/${uids.length})`);

    try {
      const { processedCount, highestUID: batchHighestUID, importantEmails } =
        await processBatch(client, batchUIDs, mailbox);

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
      logger.error(`[Email Monitor] Batch failed (${batchUIDs.length} UIDs):`, batchErr.message);
      // Continue with next batch even if this one fails
    }
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
 * @param {string} [startDate] - Optional start date for initial sync (ISO string)
 * @returns {Promise<Array>} Array of important emails with classification
 */
// One check at a time per process: the background poll, IDLE pushes and the
// chat tool may all call this; overlapping runs could notify a UID twice.
let checkQueue = Promise.resolve();

export function checkNewEmails(...args) {
  const run = checkQueue.then(() => checkNewEmailsUnlocked(...args));
  checkQueue = run.catch(() => {});
  return run;
}

async function checkNewEmailsUnlocked(imapConfig, mailbox = 'INBOX', startDate = null) {
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

        const highestUID = await performFullSync(client, lock, mailbox, status.messages, startDate);

        logger.success(`[Email Monitor] Initial sync complete - now in normal polling mode`);

        // Return empty array for first sync (don't notify about old emails)
        return [];
      }

      // Normal polling mode: fetch only new emails
      const searchCriteria = { uid: `${lastSeenUID + 1}:*` };

      logger.info(`[Email Monitor] Fetching new emails (UID > ${lastSeenUID})`);

      const { processedCount, highestUID, importantEmails } =
        await processBatch(client, searchCriteria.uid, mailbox, lastSeenUID);

      logger.info(`[Email Monitor] Found ${processedCount} new email(s)`);

      if (processedCount === 0) {
        // Update last checked time even if no new emails
        await EmailState.findOneAndUpdate(
          { mailbox },
          { lastCheckedAt: new Date() }
        );
        return [];
      }

      // Update state only if we actually saw a higher UID — never write 0 back
      if (highestUID > lastSeenUID) {
        await EmailState.findOneAndUpdate(
          { mailbox },
          {
            lastSeenUID: highestUID,
            lastCheckedAt: new Date(),
          }
        );
      } else {
        await EmailState.findOneAndUpdate(
          { mailbox },
          { lastCheckedAt: new Date() }
        );
      }

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

/**
 * Fetch one email in full (on demand, e.g. "show full mail" button)
 * @param {Object} imapConfig - { host, port, user, pass }
 * @param {number} uid
 * @param {string} [mailbox='INBOX']
 * @returns {Promise<{subject, from, date, text, attachments: string[]}|null>}
 */
export async function fetchFullEmail(imapConfig, uid, mailbox = 'INBOX') {
  const client = new ImapFlow({
    host: imapConfig.host,
    port: imapConfig.port || 993,
    secure: true,
    auth: { user: imapConfig.user, pass: imapConfig.pass },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    try {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg?.source) return null;
      const parsed = await simpleParser(msg.source);
      const text = (parsed.text || (parsed.html || '')
        .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
        .replace(/<br\s*\/?>|<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, ' '))
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      return {
        subject: parsed.subject || '(no subject)',
        from: parsed.from?.text || '',
        date: parsed.date || null,
        text,
        attachments: (parsed.attachments || []).map(a => a.filename).filter(Boolean),
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export default { checkNewEmails, fetchFullEmail };
