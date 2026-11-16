// Timezone helpers: storage is UTC, display/input is Europe/Berlin (DST-aware).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setUserTimezone, getTzOffsetMinutes, toGmtString, utcTimeToLocal, localToUtc, localDateStr, formatLocal,
} from '../src/utils/time.js';

setUserTimezone('Europe/Berlin');

test('offset follows DST (no hard-coded GMT+2)', () => {
  assert.equal(getTzOffsetMinutes('Europe/Berlin', new Date('2026-11-16T12:00:00Z')), 60);
  assert.equal(getTzOffsetMinutes('Europe/Berlin', new Date('2026-07-01T12:00:00Z')), 120);
  assert.equal(toGmtString('Europe/Berlin', new Date('2026-11-16T12:00:00Z')), 'GMT+1');
  assert.equal(getTzOffsetMinutes('GMT+2'), 120);
  assert.equal(getTzOffsetMinutes('UTC'), 0);
});

test('UTC -> local display', () => {
  assert.equal(utcTimeToLocal('07:15', '2026-11-16'), '08:15');
  assert.equal(utcTimeToLocal('07:15', '2026-07-01'), '09:15');
  assert.equal(formatLocal('2026-11-16T14:05:00Z'), '16/11/2026, 15:05');
});

test('local -> UTC storage', () => {
  assert.equal(localToUtc('2027-01-15', '09:00').toISOString(), '2027-01-15T08:00:00.000Z');
  assert.equal(localToUtc('2027-07-01', '09:00').toISOString(), '2027-07-01T07:00:00.000Z');
  // after local midnight = previous UTC day
  assert.equal(localToUtc('2027-02-03', '00:30').toISOString(), '2027-02-02T23:30:00.000Z');
});

test('local date of an instant', () => {
  assert.equal(localDateStr(new Date('2026-11-16T23:30:00Z')), '2026-11-17');
  assert.equal(localDateStr(new Date('2026-11-16T22:30:00Z')), '2026-11-16');
});
