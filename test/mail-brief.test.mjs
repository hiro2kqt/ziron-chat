// Pure mail/brief helpers: date extraction, selection, deadline reminders, Markdown escaping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setUserTimezone } from '../src/utils/time.js';
import { extractDates, selectEmails, selectSchedule } from '../src/services/briefData.js';
import { planDeadlineReminders, hasUpcomingDeadline } from '../src/tools/providers/email/reminders.js';
import { escapeMarkdown, formatEmailNotification, buildEmailKeyboard } from '../src/tools/providers/email/index.js';

setUserTimezone('Europe/Berlin');

test('extractDates: German/English/numeric, no false positives', () => {
  assert.deepEqual(extractDates('Due on Monday, 16 November 2026, 10:00 AM: PT Sheet 05', '2026-11-14'), ['2026-11-16']);
  assert.deepEqual(extractDates('Campusportal ab dem 23. November nicht erreichbar', '2026-11-05'), ['2026-11-23']);
  assert.deepEqual(extractDates('Vortrag am 23.04.', '2026-04-10'), ['2026-04-23']);
  assert.deepEqual(extractDates('Pay 339.70 EUR, lecture at 10.30', '2026-06-01'), []);
  assert.deepEqual(extractDates('Rückmeldung zum Wintersemester 2026/27', '2026-06-01'), []);
  assert.deepEqual(extractDates('Exam review tomorrow', '2026-10-27'), ['2026-10-28']);
  // year inferred forward: January mail about "20. Januar" read in late December
  assert.deepEqual(extractDates('Anmeldung bis 20. Januar', '2026-12-20'), ['2027-01-20']);
});

test('selectEmails keeps due/upcoming/new, drops past and far', () => {
  const now = new Date('2026-11-16T06:00:00Z');
  const mk = (subject, category, receivedStr, date = `${receivedStr}T10:00:00Z`) => ({ subject, summary: '', category, receivedStr, date });
  const picked = selectEmails([
    mk('Due on Monday, 16 November 2026: Sheet 5', 'assignment', '2026-11-14'),
    mk('Due on Monday, 9 November 2026: Sheet 4', 'assignment', '2026-11-07'),
    mk('No lecture on December 15', 'course', '2026-11-09'),
    mk('Exam on 18 November', 'exam', '2026-11-10'),
    mk('Invitation to summer party', 'other', '2026-11-15'),
  ], '2026-11-16', now);
  assert.deepEqual(picked.map(e => e.reason), ['due', 'upcoming']);
});

test('selectSchedule drops every-day routines and weather jobs', () => {
  const items = [
    { name: 'water', everyDay: true, oneshot: false, isTool: false },
    { name: 'weather', everyDay: true, oneshot: false, isTool: true },
    { name: 'class tue/thu', everyDay: false, oneshot: false, isTool: false },
    { name: 'deadline', everyDay: false, oneshot: true, isTool: false },
  ];
  assert.deepEqual(selectSchedule(items).map(i => i.name), ['class tue/thu', 'deadline']);
});

test('deadline reminders: D-3, D-1, day-of; only future; time-aware', () => {
  const now = new Date('2026-01-08T10:00:00Z');
  assert.deepEqual(planDeadlineReminders('2026-01-20', now).map(s => s.utc.toISOString()), [
    '2026-01-17T08:00:00.000Z', '2026-01-19T08:00:00.000Z', '2026-01-20T07:00:00.000Z',
  ]);
  assert.equal(planDeadlineReminders('2026-11-20T14:00', new Date('2026-11-16T16:00:00Z')).at(-1).time, '12:00');
  assert.deepEqual(planDeadlineReminders('2026-01-01', now), []);
  assert.equal(hasUpcomingDeadline(null), false);
});

test('notification escapes Markdown and builds buttons', () => {
  assert.equal(escapeMarkdown('lsf-ASL-26_1 *x* [y]'), 'lsf-ASL-26\\_1 \\*x\\* \\[y]');
  const deadline = '2099-01-20';
  const emails = [{ uid: 7, subject: 'lsf-ASL-26_1: Registration', classification: { category: 'registration', summary: 'Register', deadline } }];
  assert.match(formatEmailNotification(emails), /lsf-ASL-26\\_1/);
  assert.deepEqual(buildEmailKeyboard(emails).inline_keyboard[0].map(b => b.callback_data), ['!act:mail:7', '!act:mremind:7']);
});
