import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { planRsvpReminder, isCurrentResponse, RSVP_REMINDER_LEAD_MS, RSVP_REMINDER_MIN_REMAINING_MS } = require('./lib/notifications/reminderPlan.js');

const now = Date.parse('2026-10-20T12:00:00.000Z');
const open = { status: 'scheduled', resourceClosed: false, published: true, scheduleVersion: 1, sentKey: null };
const plan = (patch) => planRsvpReminder({ nowMs: now, deadlineMs: now + RSVP_REMINDER_LEAD_MS, ...open, ...patch });

test('reminder timing sends once at the lead, immediately inside the window, and never in the final hour', () => {
  const lead = plan({ deadlineMs: now + RSVP_REMINDER_LEAD_MS });
  assert.equal(lead.action, 'send');
  assert.equal(lead.reason, 'due');
  assert.equal(lead.dueAtMs, now);
  const before = plan({ nowMs: now - 1, deadlineMs: now + RSVP_REMINDER_LEAD_MS });
  assert.equal(before.action, 'wait');
  assert.equal(before.reason, 'before_window');
  assert.equal(before.dueAtMs, now);
  const stillWaiting = plan({ deadlineMs: now + RSVP_REMINDER_LEAD_MS + 1 });
  assert.equal(stillWaiting.action, 'wait');
  assert.equal(stillWaiting.dueAtMs, now + 1);
  const immediate = plan({ deadlineMs: now + RSVP_REMINDER_MIN_REMAINING_MS + 1 });
  assert.equal(immediate.action, 'send');
  assert.equal(immediate.reason, 'immediate');
  const finalHour = plan({ deadlineMs: now + RSVP_REMINDER_MIN_REMAINING_MS });
  assert.equal(finalHour.action, 'skip');
  assert.equal(finalHour.reason, 'too_late');
  assert.equal(finalHour.dueAtMs, null);
});

test('a sent reminder matches only its schedule version and deadline', () => {
  const first = plan({ deadlineMs: now + 10 * 60 * 60 * 1000 });
  assert.equal(plan({ deadlineMs: now + 10 * 60 * 60 * 1000, sentKey: first.key }).reason, 'already_sent');
  const moved = plan({ deadlineMs: now + 40 * 60 * 60 * 1000, sentKey: first.key });
  assert.equal(moved.action, 'wait');
  assert.notEqual(moved.key, first.key);
  const rescheduled = plan({ deadlineMs: now + 10 * 60 * 60 * 1000, scheduleVersion: 2, sentKey: first.key });
  assert.equal(rescheduled.action, 'send');
  assert.equal(rescheduled.reason, 'immediate');
  assert.notEqual(rescheduled.key, first.key);
});

test('closed, unpublished and answered rows are not current reminder candidates', () => {
  for (const patch of [
    { status: 'cancelled' },
    { status: 'postponed' },
    { status: 'completed' },
    { resourceClosed: true },
    { published: false },
    { deadlineMs: Number.NaN },
  ]) assert.equal(plan(patch).action, 'skip');
  assert.equal(plan({ published: false }).reason, 'unpublished');
  assert.equal(plan({ status: 'cancelled' }).reason, 'closed');
  assert.equal(isCurrentResponse(undefined, 1), false);
  assert.equal(isCurrentResponse({ status: 'yes', scheduleVersion: 1 }, 2), false);
  for (const status of ['yes', 'no', 'maybe']) assert.equal(isCurrentResponse({ status, scheduleVersion: 3 }, 3), true);
  assert.equal(isCurrentResponse({ status: 'unanswered', scheduleVersion: 3 }, 3), false);
});
