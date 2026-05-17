/**
 * Debug script: check-email-uid.js
 * Compares lastSeenUID in MongoDB against the actual highest UID on IMAP.
 * Diagnoses the re-fetch/re-notify bug in monitor.js.
 *
 * Usage: node src/scripts/check-email-uid.js
 */

import { ImapFlow } from 'imapflow';
import mongoose from 'mongoose';
import { loadConfig } from '../config/index.js';

// ── Inline minimal models (avoid side-effects from importing the full app) ────

const emailStateSchema = new mongoose.Schema({
  mailbox:       { type: String, required: true, unique: true },
  lastSeenUID:   { type: Number, required: true, default: 0 },
  lastCheckedAt: { type: Date,   default: null },
}, { timestamps: true });

const emailSchema = new mongoose.Schema({
  uid:       { type: Number, required: true },
  mailbox:   { type: String, required: true },
  subject:   { type: String, required: true },
  from:      { type: String, required: true },
  date:      { type: Date,   required: true },
  important: { type: Boolean, default: false },
  category:  { type: String },
}, { timestamps: true });

emailSchema.index({ mailbox: 1, uid: 1 }, { unique: true });

const EmailState = mongoose.model('EmailState', emailStateSchema);
const Email      = mongoose.model('Email',      emailSchema);

// ── Helpers ───────────────────────────────────────────────────────────────────

const hr = (char = '─', len = 60) => char.repeat(len);

function fmt(label, value, width = 28) {
  return `  ${label.padEnd(width)} ${value}`;
}

function fmtDate(d) {
  if (!d) return '(none)';
  return new Date(d).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

// ── MongoDB section ───────────────────────────────────────────────────────────

async function checkMongo(mongoUri) {
  console.log('\n' + hr('─'));
  console.log('  MONGODB');
  console.log(hr('─'));

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
  console.log(fmt('URI:', mongoUri.replace(/:\/\/[^@]+@/, '://***@')));  // hide credentials

  // EmailState
  const state = await EmailState.findOne({ mailbox: 'INBOX' });

  if (!state) {
    console.log(fmt('EmailState (INBOX):', 'NOT FOUND — monitor has never run'));
  } else {
    console.log(fmt('lastSeenUID:', state.lastSeenUID === 0
      ? `0  ⚠  (cursor is at zero — full sync will re-trigger!)`
      : String(state.lastSeenUID)));
    console.log(fmt('lastCheckedAt:', fmtDate(state.lastCheckedAt)));
    console.log(fmt('State createdAt:', fmtDate(state.createdAt)));
    console.log(fmt('State updatedAt:', fmtDate(state.updatedAt)));
  }

  // Email collection stats
  const totalEmails     = await Email.countDocuments({ mailbox: 'INBOX' });
  const importantEmails = await Email.countDocuments({ mailbox: 'INBOX', important: true });

  const oldest = await Email.findOne({ mailbox: 'INBOX' }).sort({ date:  1 }).select('date subject uid').lean();
  const newest = await Email.findOne({ mailbox: 'INBOX' }).sort({ date: -1 }).select('date subject uid').lean();

  const highestStoredUID = await Email
    .findOne({ mailbox: 'INBOX' })
    .sort({ uid: -1 })
    .select('uid')
    .lean();

  console.log();
  console.log(fmt('Emails stored (INBOX):', String(totalEmails)));
  console.log(fmt('  of which important:', String(importantEmails)));
  console.log(fmt('Highest UID in Email coll:', highestStoredUID ? String(highestStoredUID.uid) : '(none)'));

  if (oldest) {
    console.log(fmt('Oldest email:', `${fmtDate(oldest.date)}  UID=${oldest.uid}`));
    console.log(fmt('  subject:', oldest.subject?.slice(0, 50)));
  }
  if (newest) {
    console.log(fmt('Newest email:', `${fmtDate(newest.date)}  UID=${newest.uid}`));
    console.log(fmt('  subject:', newest.subject?.slice(0, 50)));
  }

  return {
    stateExists:      !!state,
    lastSeenUID:      state?.lastSeenUID ?? null,
    lastCheckedAt:    state?.lastCheckedAt ?? null,
    totalEmails,
    highestStoredUID: highestStoredUID?.uid ?? null,
  };
}

// ── IMAP section ──────────────────────────────────────────────────────────────

async function checkImap(imapConfig) {
  console.log('\n' + hr('─'));
  console.log('  IMAP');
  console.log(hr('─'));

  const { host, port, user, pass } = imapConfig;
  console.log(fmt('Host:', `${host}:${port}`));
  console.log(fmt('User:', user));

  const client = new ImapFlow({
    host, port, secure: true,
    auth: { user, pass },
    logger: false,
  });

  await client.connect();
  console.log(fmt('Connection:', 'OK'));

  const lock = await client.getMailboxLock('INBOX');
  let result;

  try {
    const status = await client.status('INBOX', {
      messages: true,
      uidNext:  true,
      unseen:   true,
    });

    // uidNext is "next UID the server will assign" → highest existing = uidNext - 1
    const highestUID = status.uidNext - 1;

    console.log(fmt('Total messages:', String(status.messages)));
    console.log(fmt('Unseen:', String(status.unseen)));
    console.log(fmt('uidNext (server):', String(status.uidNext)));
    console.log(fmt('Highest UID (uidNext-1):', String(highestUID)));

    result = { totalMessages: status.messages, highestUID, unseen: status.unseen };

  } finally {
    lock.release();
  }

  await client.logout();
  return result;
}

// ── Comparison / diagnosis ────────────────────────────────────────────────────

function diagnose(mongo, imap) {
  console.log('\n' + hr('═'));
  console.log('  DIAGNOSIS');
  console.log(hr('═'));

  const issues = [];
  const ok     = [];

  // 1. State existence
  if (!mongo.stateExists) {
    issues.push('EmailState document missing — monitor has never run or MongoDB was wiped.');
  } else {
    ok.push('EmailState document exists.');
  }

  // 2. lastSeenUID is 0 but emails exist on IMAP
  if (mongo.lastSeenUID === 0 && imap.totalMessages > 0) {
    issues.push(
      `lastSeenUID is 0 but IMAP has ${imap.totalMessages} messages.\n` +
      `    Next poll will trigger performFullSync() and re-classify all emails.`
    );
  } else if (mongo.lastSeenUID === 0 && imap.totalMessages === 0) {
    ok.push('lastSeenUID is 0 and IMAP mailbox is empty — consistent.');
  } else {
    ok.push(`lastSeenUID (${mongo.lastSeenUID}) is non-zero — cursor looks set.`);
  }

  // 3. lastSeenUID vs IMAP highest UID
  if (mongo.lastSeenUID !== null && imap.highestUID >= 0) {
    if (mongo.lastSeenUID > imap.highestUID) {
      issues.push(
        `lastSeenUID (${mongo.lastSeenUID}) > IMAP highest UID (${imap.highestUID}).\n` +
        `    This can happen after emails are deleted server-side.`
      );
    } else if (mongo.lastSeenUID === imap.highestUID) {
      ok.push(`lastSeenUID (${mongo.lastSeenUID}) matches IMAP highest UID — fully caught up.`);
    } else {
      const gap = imap.highestUID - mongo.lastSeenUID;
      ok.push(`lastSeenUID (${mongo.lastSeenUID}) is ${gap} UID(s) behind IMAP highest (${imap.highestUID}) — normal if new mail arrived.`);
    }
  }

  // 4. highestStoredUID vs lastSeenUID
  if (mongo.highestStoredUID !== null && mongo.lastSeenUID !== null) {
    if (mongo.highestStoredUID > mongo.lastSeenUID) {
      issues.push(
        `Highest UID stored in Email collection (${mongo.highestStoredUID}) > lastSeenUID (${mongo.lastSeenUID}).\n` +
        `    lastSeenUID was reset to 0 mid-sync and re-saved incorrectly.`
      );
    } else {
      ok.push(`Highest stored UID (${mongo.highestStoredUID}) <= lastSeenUID (${mongo.lastSeenUID}) — consistent.`);
    }
  }

  // 5. Emails stored vs IMAP total
  if (mongo.totalEmails === 0 && imap.totalMessages > 0) {
    issues.push(
      `No emails stored in MongoDB but IMAP has ${imap.totalMessages} messages.\n` +
      `    Monitor may have run but classification/save failed, or MongoDB was wiped.`
    );
  }

  // ── Print results ──
  if (ok.length > 0) {
    console.log('\n  OK:');
    ok.forEach(msg => console.log(`    ✓  ${msg}`));
  }

  if (issues.length > 0) {
    console.log('\n  ISSUES FOUND:');
    issues.forEach((msg, i) => console.log(`    ✗  [${i + 1}] ${msg}`));
    console.log();
    console.log('  Root cause of re-fetch/re-notify bug:');
    console.log('    processBatch() returns highestUID=0 when IMAP yields 0 messages.');
    console.log('    checkNewEmails() then writes lastSeenUID:0 unconditionally (line 283).');
    console.log('    Next poll sees lastSeenUID===0 → triggers performFullSync() again.');
    console.log('    Fix: guard the update — only write highestUID if highestUID > 0.');
  } else {
    console.log('\n  No issues detected — cursor state looks healthy.');
  }

  console.log('\n' + hr('═'));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(hr('═'));
  console.log('  ZIRON EMAIL UID DEBUG CHECK');
  console.log(`  ${new Date().toISOString()}`);
  console.log(hr('═'));

  const config = loadConfig();

  // Validate config
  const mongoUri  = config.database?.mongoUri;
  const imapConfig = config.tools?.email?.imap;

  if (!mongoUri) {
    console.error('\n  ERROR: config.database.mongoUri is not set in config.json');
    process.exit(1);
  }

  if (!imapConfig?.host || !imapConfig?.user || !imapConfig?.pass) {
    console.error('\n  ERROR: config.tools.email.imap is incomplete (need host, user, pass)');
    process.exit(1);
  }

  if (!config.tools?.email?.enabled) {
    console.warn('\n  WARN: config.tools.email.enabled is false — script will still run');
  }

  let mongoResult, imapResult;

  try {
    mongoResult = await checkMongo(mongoUri);
  } catch (err) {
    console.error('\n  MongoDB ERROR:', err.message);
    process.exit(1);
  }

  try {
    imapResult = await checkImap(imapConfig);
  } catch (err) {
    console.error('\n  IMAP ERROR:', err.message);
    await mongoose.disconnect();
    process.exit(1);
  }

  diagnose(mongoResult, imapResult);

  await mongoose.disconnect();
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
