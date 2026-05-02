import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

// ─── Config ───────────────────────────────────────────────
// NOTE: This is a test script. For production use, configure
// email monitoring in config.json under tools.email
const config = {
  host: process.env.IMAP_HOST || 'unimail.tu-dortmund.de',
  port: parseInt(process.env.IMAP_PORT || '993'),
  secure: true,
  auth: {
    user: process.env.IMAP_USER || '',
    pass: process.env.IMAP_PASS || '',
  },
  logger: false,
};

const FETCH_COUNT = 5; // lấy 5 mail mới nhất
// ──────────────────────────────────────────────────────────

async function fetchLatestMails() {
  const client = new ImapFlow(config);

  await client.connect();
  console.log('✅ Connected to', config.host);

  const lock = await client.getMailboxLock('INBOX');

  try {
    const status = await client.status('INBOX', { messages: true, unseen: true });
    console.log(`📬 INBOX: ${status.messages} total, ${status.unseen} unread\n`);

    // Lấy N mail mới nhất theo sequence number
    const total = status.messages;
    const from = Math.max(1, total - FETCH_COUNT + 1);
    const range = `${from}:${total}`;

    const mails = [];

    for await (const msg of client.fetch(range, { source: true })) {
      const parsed = await simpleParser(msg.source);
      mails.push({
        seq: msg.seq,
        uid: msg.uid,
        subject: parsed.subject || '(no subject)',
        from: parsed.from?.text || '',
        date: parsed.date?.toISOString() || '',
        snippet: (parsed.text || parsed.html || '')
          .replace(/<[^>]+>/g, '') // strip HTML tags
          .trim()
          .slice(0, 200),
      });
    }

    // Log ra theo thứ tự mới nhất trước
    mails.reverse().forEach((m, i) => {
      console.log(`─── Mail #${i + 1} (UID ${m.uid}) ${'─'.repeat(40)}`);
      console.log(`📌 Subject : ${m.subject}`);
      console.log(`👤 From    : ${m.from}`);
      console.log(`📅 Date    : ${m.date}`);
      console.log(`📄 Snippet : ${m.snippet || '(empty)'}`);
      console.log();
    });

  } finally {
    lock.release();
  }

  await client.logout();
  console.log('👋 Done');
}

fetchLatestMails().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});