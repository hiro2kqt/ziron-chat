// Scheduler: DST/midnight occurrence math and the duplicate-send race.
// Uses a throwaway HOME so the real ~/.ziron databases are never touched.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ziron-test-'));
const { setUserTimezone, localToUtc } = await import('../src/utils/time.js');
const { occurrenceOn, occurrencesForDate, shouldRunToday } = await import('../src/scheduler/sync.js');
const db = await import('../src/scheduler/db.js');
const { checkAndFire } = await import('../src/scheduler/poller.js');

setUserTimezone('Europe/Berlin');
before(() => db.initDatabases());

const job = (time, tz_offset_min, extra = {}) => ({
  id: 'j', time_triggers: [{ time, message: 'm' }], tz_offset_min, repeat_days: [], specific_dates: [], ...extra,
});

test('recurring time keeps local wall-clock across DST', () => {
  // created in winter for 08:15 local (07:15 UTC, offset 60)
  assert.deepEqual(occurrenceOn(job('07:15', 60), { time: '07:15' }, '2026-11-17'), { date: '2026-11-17', time: '07:15' });
  assert.deepEqual(occurrenceOn(job('07:15', 60), { time: '07:15' }, '2027-07-01'), { date: '2027-07-01', time: '06:15' });
});

test('DST shift across midnight moves the date (no 24h-early fire)', () => {
  // created in SUMMER for 01:30 local = 23:30 UTC on the previous day (offset 120)
  const j = job('23:30', 120);
  // in WINTER that local time is 00:30 UTC of the NEXT UTC date
  assert.deepEqual(occurrenceOn(j, j.time_triggers[0], '2026-12-01'), { date: '2026-12-02', time: '00:30' });
  // so syncing 2026-12-02 must create it, and nothing lands at 00:30 of 2026-12-01 from that source day
  const daily = { ...j }; // every day
  assert.deepEqual(occurrencesForDate(daily, '2026-12-02').map(o => o.time), ['00:30']);
});

test('specific date after local midnight (stored on previous UTC day)', () => {
  const u = localToUtc('2027-02-03', '00:30').toISOString(); // 2027-02-02T23:30Z
  const j = job(u.slice(11, 16), 60, { specific_dates: [u.slice(0, 10)] });
  assert.equal(occurrencesForDate(j, '2027-02-02').length, 1);
  assert.equal(occurrencesForDate(j, '2027-02-03').length, 0);
});

test('shouldRunToday uses the given date, not "now"', () => {
  const tueThu = job('07:15', 60, { repeat_days: [2, 4] });
  assert.equal(shouldRunToday(tueThu, '2026-11-17'), true);  // Tuesday
  assert.equal(shouldRunToday(tueThu, '2026-11-18'), false); // Wednesday
});

test('a due job is sent exactly once even with overlapping slow ticks', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString().slice(11, 19);
  db.insertTodayJob({ name: 'race', chat_id: '1', fire_at: now, message: 'hi', date: today, source: 'oneshot' });
  let sends = 0;
  const slowSend = async () => { sends++; await new Promise(r => setTimeout(r, 300)); };
  await Promise.all([checkAndFire(slowSend), checkAndFire(slowSend), checkAndFire(slowSend)]);
  assert.equal(sends, 1);
});

test('future-dated one-shots survive and are found by ref_id', () => {
  db.insertTodayJob({ name: 'd', chat_id: '1', fire_at: '08:00', message: 'x', date: '2099-01-01', source: 'oneshot', ref_id: 'mail-1' });
  assert.equal(db.getPendingJobsByRefId('mail-1').length, 1);
  db.deletePastTodayJobs('00:00:00', new Date().toISOString().slice(0, 10));
  assert.equal(db.getPendingJobsByRefId('mail-1').length, 1);
  assert.equal(db.deletePendingJobsByRefId('mail-1'), 1);
});
