// Mail classifier eval: re-classifies the stored mails (Mongo `emails`, read-only)
// with the current prompt / model / routing and compares `important` with the
// hand-checked labels in eval-classifier-labels.json. Run before changing the
// classifier prompt, model or provider routing.
//
//   node src/scripts/eval-classifier.mjs [--model <id>] [--limit N] [--out results.json]
//
// Costs ~$0.045 per full run (268 mails) on the default model. Mail content goes
// to OpenRouter exactly as in production (private routing).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import mongoose from 'mongoose';
import { loadConfig } from '../config/index.js';
import { classifyEmail } from '../tools/providers/email/classifier.js';

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const model = arg('--model');
const limit = Number(arg('--limit') || 0);
const outPath = arg('--out');

const here = dirname(fileURLToPath(import.meta.url));
const { labels } = JSON.parse(fs.readFileSync(join(here, 'eval-classifier-labels.json'), 'utf8'));

const config = loadConfig();
await mongoose.connect(config.database.mongoUri);
const ids = Object.keys(labels).map(Number);
let mails = await mongoose.connection.db.collection('emails')
  .find({ mailbox: 'INBOX', uid: { $in: ids } }).sort({ uid: -1 }).toArray();
if (limit) mails = mails.slice(0, limit);

const results = [];
for (let i = 0; i < mails.length; i += 6) {
  const batch = mails.slice(i, i + 6);
  const rs = await Promise.all(batch.map(m => classifyEmail(m, { model }).catch(e => ({ error: e.message }))));
  batch.forEach((m, j) => results.push({ uid: m.uid, subject: m.subject, result: rs[j] }));
  process.stderr.write(`\r${results.length}/${mails.length}`);
}
process.stderr.write('\n');

let ok = 0;
const missed = [], extra = [], errors = [];
for (const { uid, subject, result } of results) {
  if (result.error) errors.push(`${uid} ${result.error}`);
  const want = labels[uid], got = Boolean(result.important);
  if (want === got) ok++;
  else (want ? missed : extra).push(`${uid} [${result.category}] ${subject.slice(0, 80)} — ${result.reason}`);
}
console.log(`model ${model || '(config)'}: ${ok}/${results.length} correct, missed ${missed.length}, extra ${extra.length}, errors ${errors.length}`);
missed.forEach(l => console.log('  MISSED', l));
extra.forEach(l => console.log('  EXTRA ', l));
errors.forEach(l => console.log('  ERROR ', l));
console.log(`with deadline: ${results.filter(r => r.result.deadline).length}`);
if (outPath) fs.writeFileSync(outPath, JSON.stringify(results, null, 1));
await mongoose.disconnect();
