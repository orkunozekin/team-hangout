import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { projectId, requireEmulators } from './fixtures.mjs';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp: adminApp, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getAuth: adminAuth } = require('firebase-admin/auth');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { fingerprint } = require('./lib/operations/requests.js');
requireEmulators();
let admin, db; const apps = {};
const call = async (uid, name, data = {}) => (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const now = Date.parse('2026-10-20T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const meta = { schemaVersion: 2, revision: 1, status: 'active', createdAt: Timestamp.now(), updatedAt: Timestamp.now() };
const reminders = require('./lib/notifications/reminders.js');
const issues = require('./lib/notifications/issues.js');
const worker = require('./lib/notifications/worker.js');
const deletion = require('./lib/accounts/deletion.js');
const event = (id, patch = {}) => {
  const startsAtMs = patch.startsAtMs ?? now + 48 * HOUR;
  return { ...meta, revision: patch.revision ?? 3, orgId: patch.orgId ?? 'remind-org', programId: 'remind-program', seasonId: 'remind-season', divisionId: 'remind-division',
    teamId: 'remind-team', teamIds: ['remind-team'], title: 'Synthetic practice', type: 'practice', timeZone: 'America/Chicago', status: patch.status ?? 'scheduled',
    startsAt: Timestamp.fromMillis(startsAtMs), endsAt: Timestamp.fromMillis(startsAtMs + HOUR), publicationState: patch.publicationState ?? 'published',
    publicationOperationId: null, deletedAt: null, scheduleVersion: patch.scheduleVersion ?? 1,
    ...(patch.deadlineMs === undefined ? {} : { rsvpDeadline: patch.deadlineMs == null ? null : Timestamp.fromMillis(patch.deadlineMs) }),
    resourceClosed: false };
};
const intentsFor = (eventId) => db.collection('organizations/remind-org/outbox').where('sourceId', '==', eventId).where('templateKey', '==', 'rsvpReminder').get();
before(async () => {
  admin = adminApp({ projectId }); db = getFirestore(admin);
  for (const uid of ['remind-admin', 'remind-coach', 'remind-guardian', 'remind-viewer', 'remind-self', 'remind-outsider', 'remind-staff']) {
    const app = initializeApp({ projectId, apiKey: 'demo-key' }, uid); apps[uid] = app;
    connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), '127.0.0.1', 5001);
    await adminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password: 'SyntheticPassword123!' });
    await db.doc(`users/${uid}`).set({ uid, email: `${uid}@example.test`, appRole: 'user' });
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, 'SyntheticPassword123!');
  }
  await db.doc('organizations/remind-org').set({ ...meta, name: 'Synthetic reminders', features: { organizationV2: true, households: true, notificationInboxFake: true, rsvpReminders: true, adminWorkspace: true } });
  await db.doc('organizations/remind-off').set({ ...meta, name: 'Reminders disabled', features: { organizationV2: true, rsvpReminders: false } });
  for (const [kind, id] of [['programs', 'remind-program'], ['seasons', 'remind-season'], ['divisions', 'remind-division']])
    await db.doc(`organizations/remind-org/${kind}/${id}`).set({ ...meta, orgId: 'remind-org', programId: 'remind-program', seasonId: 'remind-season', name: id });
  await db.doc('organizations/remind-org/programs/other-program').set({ ...meta, orgId: 'remind-org', name: 'Other' });
  await db.doc('organizations/remind-org/members/remind-admin').set({ ...meta, orgId: 'remind-org', roles: ['orgAdmin'], programIds: [] });
  await db.doc('organizations/remind-org/members/remind-staff').set({ ...meta, orgId: 'remind-org', roles: ['programStaff'], programIds: ['other-program'] });
  await db.doc('teams/remind-team').set({ ...meta, orgId: 'remind-org', programId: 'remind-program', seasonId: 'remind-season', divisionId: 'remind-division', name: 'Falcons' });
  await db.doc('teamMembers/remind-team_remind-coach').set({ ...meta, orgId: 'remind-org', teamId: 'remind-team', userId: 'remind-coach', roles: ['coach'] });
  await db.doc('organizations/remind-org/participants/remind-child').set({ ...meta, orgId: 'remind-org', displayName: 'Jamie', linkedUserId: 'remind-self' });
  await db.doc('organizations/remind-org/participants/remind-sibling').set({ ...meta, orgId: 'remind-org', displayName: 'Alex', linkedUserId: null });
  await db.doc('organizations/remind-org/participants/remind-child/guardians/remind-guardian').set({ ...meta, orgId: 'remind-org', participantId: 'remind-child', userId: 'remind-guardian', permissions: { viewSchedule: true, respond: true } });
  await db.doc('organizations/remind-org/participants/remind-sibling/guardians/remind-guardian').set({ ...meta, orgId: 'remind-org', participantId: 'remind-sibling', userId: 'remind-guardian', permissions: { viewSchedule: true, respond: true } });
  await db.doc('organizations/remind-org/participants/remind-child/guardians/remind-viewer').set({ ...meta, orgId: 'remind-org', participantId: 'remind-child', userId: 'remind-viewer', permissions: { viewSchedule: true, respond: false } });
  await db.doc('teams/remind-team/roster/remind-child').set({ ...meta, orgId: 'remind-org', participantId: 'remind-child' });
  await db.doc('teams/remind-team/roster/remind-sibling').set({ ...meta, orgId: 'remind-org', participantId: 'remind-sibling' });
});
after(async () => { await Promise.all(Object.values(apps).map(deleteApp)); await deleteAdmin(admin); });

test('a moved deadline does not send the old reminder and sends once for the new deadline', async () => {
  const id = 'deadline-event';
  await db.doc(`events/${id}`).set(event(id, { deadlineMs: now + 30 * HOUR }));
  const planned = await reminders.syncRsvpReminder('remind-org', id, now);
  assert.equal(planned.state, 'scheduled'); assert.equal(planned.reason, 'before_window');
  assert.equal((await db.doc(`organizations/remind-org/rsvpReminders/${id}`).get()).data().dueAt.toMillis(), now + 6 * HOUR);
  assert.equal((await reminders.dispatchDueRsvpReminders(now)).scanned, 0);
  assert.equal((await intentsFor(id)).size, 0);
  await db.doc(`events/${id}`).update({ rsvpDeadline: Timestamp.fromMillis(now + 10 * HOUR), revision: 4 });
  const sent = await reminders.dispatchRsvpReminder('remind-org', id, now);
  assert.equal(sent.result, 'sent'); assert.ok(sent.recipientCount >= 1); assert.equal((await intentsFor(id)).size, 1);
  const again = await reminders.dispatchRsvpReminder('remind-org', id, now + 6 * HOUR);
  assert.equal(again.result, 'already_sent'); assert.equal((await intentsFor(id)).size, 1);
  await db.doc(`events/${id}`).update({ rsvpDeadline: Timestamp.fromMillis(now + 40 * HOUR), revision: 5 });
  const waiting = await reminders.dispatchRsvpReminder('remind-org', id, now + 6 * HOUR);
  assert.equal(waiting.result, 'wait');
  const reminder = (await db.doc(`organizations/remind-org/rsvpReminders/${id}`).get()).data();
  assert.equal(reminder.state, 'scheduled'); assert.equal(reminder.dueAt.toMillis(), now + 16 * HOUR);
  assert.equal((await intentsFor(id)).size, 1);
});

test('reschedule reminds people who need reconfirmation once, even from repeated scheduler runs', async () => {
  const id = 'reschedule-event';
  await db.doc(`events/${id}`).set(event(id, { deadlineMs: now + 3 * HOUR }));
  await db.doc(`events/${id}/availability/remind-child`).set({ ...meta, orgId: 'remind-org', status: 'yes', scheduleVersion: 1 });
  await db.doc(`events/${id}/availability/remind-sibling`).set({ ...meta, orgId: 'remind-org', status: 'yes', scheduleVersion: 1 });
  const answered = await reminders.dispatchRsvpReminder('remind-org', id, now);
  assert.equal(answered.result, 'sent'); assert.equal(answered.recipientCount, 0); assert.equal((await intentsFor(id)).size, 0);
  await db.doc(`events/${id}`).update({ scheduleVersion: 2, startsAt: Timestamp.fromMillis(now + 10 * HOUR), endsAt: Timestamp.fromMillis(now + 11 * HOUR), rsvpDeadline: null, revision: 4 });
  const [first, second] = await Promise.all([reminders.dispatchRsvpReminder('remind-org', id, now), reminders.dispatchRsvpReminder('remind-org', id, now)]);
  assert.deepEqual(first.result === 'sent' || second.result === 'sent', true);
  assert.equal((await intentsFor(id)).size, 1);
  const third = await reminders.dispatchDueRsvpReminders(now + HOUR);
  assert.equal(third.results.filter(row => row.eventId === id && row.result === 'sent').length, 0);
  assert.equal((await intentsFor(id)).size, 1);
  const intent = (await intentsFor(id)).docs[0];
  const uids = intent.data().audience.recipients.map(row => row.uid).sort();
  assert.deepEqual(uids, ['remind-guardian', 'remind-self']);
  assert.equal(intent.data().audience.recipients.find(row => row.uid === 'remind-guardian').accessSources.length, 2);
  await worker.expandNotificationIntent('remind-org', intent.id);
  for (const uid of ['remind-guardian', 'remind-self']) assert.equal((await db.collection(`users/${uid}/notifications`).where('sourceId', '==', id).get()).size, 1);
  for (const uid of ['remind-coach', 'remind-viewer', 'remind-admin']) assert.equal((await db.collection(`users/${uid}/notifications`).where('sourceId', '==', id).get()).size, 0);
  await db.doc(`events/${id}/availability/remind-child`).update({ scheduleVersion: 2 });
  await db.doc(`events/${id}/availability/remind-sibling`).update({ scheduleVersion: 2 });
});

test('a response recorded before expansion removes that recipient and maybe is already answered', async () => {
  const id = 'responded-event';
  await db.doc(`events/${id}`).set(event(id, { deadlineMs: now + 5 * HOUR }));
  await db.doc(`events/${id}/availability/remind-sibling`).set({ ...meta, status: 'maybe', scheduleVersion: 1 });
  const sent = await reminders.dispatchRsvpReminder('remind-org', id, now);
  assert.equal(sent.recipientCount, 2);
  await db.doc(`events/${id}/availability/remind-child`).set({ ...meta, status: 'yes', scheduleVersion: 1 });
  const intent = (await intentsFor(id)).docs[0];
  await worker.expandNotificationIntent('remind-org', intent.id);
  assert.equal((await db.collection('users/remind-self/notifications').where('sourceId', '==', id).get()).size, 0);
  assert.equal((await db.collection('users/remind-guardian/notifications').where('sourceId', '==', id).get()).size, 0);
});

test('two unanswered participants produce one guardian reminder and exclude view-only adults', async () => {
  const id = 'deduped-event';
  await db.doc(`events/${id}`).set(event(id, { deadlineMs: now + 4 * HOUR }));
  const sent = await reminders.dispatchRsvpReminder('remind-org', id, now);
  assert.equal(sent.recipientCount, 2);
  const intent = (await intentsFor(id)).docs[0];
  await worker.expandNotificationIntent('remind-org', intent.id);
  const guardian = (await db.collection('users/remind-guardian/notifications').where('sourceId', '==', id).get()).docs[0].data();
  assert.deepEqual(guardian.accessSources.map(row => row.participantId).sort(), ['remind-child', 'remind-sibling']);
  assert.equal((await db.collection('users/remind-viewer/notifications').where('sourceId', '==', id).get()).size, 0);
  assert.equal((await db.collection('users/remind-coach/notifications').where('sourceId', '==', id).get()).size, 0);
});

test('disabled, unpublished and cancelled events do not send', async () => {
  await db.doc('organizations/remind-org').update({ 'features.rsvpReminders': false });
  await db.doc('events/disabled-event').set(event('disabled-event', { deadlineMs: now + 3 * HOUR }));
  assert.equal((await reminders.syncRsvpReminder('remind-org', 'disabled-event', now)).state, 'paused');
  assert.equal((await reminders.dispatchRsvpReminder('remind-org', 'disabled-event', now)).result, 'disabled');
  assert.equal((await intentsFor('disabled-event')).size, 0);
  await db.doc('organizations/remind-org').update({ 'features.rsvpReminders': true });
  await db.doc('events/staged-event').set(event('staged-event', { publicationState: 'staged', deadlineMs: now + 3 * HOUR }));
  assert.equal((await reminders.syncRsvpReminder('remind-org', 'staged-event', now)).reason, 'unpublished');
  await db.doc('events/cancelled-event').set(event('cancelled-event', { status: 'cancelled', deadlineMs: now + 3 * HOUR }));
  assert.equal((await reminders.syncRsvpReminder('remind-org', 'cancelled-event', now)).reason, 'closed');
});

test('the scheduler prepares a published event and skips an organization with reminders disabled', async () => {
  await db.doc('events/scan-event').set(event('scan-event', { startsAtMs: now + 48 * HOUR }));
  await db.doc('events/off-event').set(event('off-event', { orgId: 'remind-off', startsAtMs: now + 36 * HOUR }));
  let reminder;
  for (let page = 0; page < 40 && !reminder; page += 1) {
    await reminders.scanUpcomingReminders(now);
    reminder = (await db.doc('organizations/remind-org/rsvpReminders/scan-event').get()).data();
  }
  assert.equal(reminder.state, 'scheduled');
  assert.equal((await db.doc('organizations/remind-off/rsvpReminders/off-event').get()).exists, false);
});

test('bounced email and expired push tokens are failures, while read is not acknowledgement', async () => {
  await db.doc('organizations/remind-org/outbox/critical-intent').set({ ...meta, orgId: 'remind-org', sourceType: 'event', sourceId: 'critical-event', sourceRevision: 2,
    templateKey: 'event:reschedule', critical: true, state: 'pending', programId: 'remind-program', audience: { teamIds: ['remind-team'] } });
  await db.doc('events/critical-event').set(event('critical-event'));
  await worker.expandNotificationIntent('remind-org', 'critical-intent');
  const inbox = (await call('remind-guardian', 'listNotifications')).items.find(row => row.sourceId === 'critical-event');
  assert.equal(inbox.acknowledgedAt, null);
  const read = await call('remind-guardian', 'markNotificationRead', { notificationId: inbox.id, sourceRevision: 2, requestId: 'remind-read' });
  assert.ok(read.readAt); assert.equal(read.acknowledgedAt, null);
  const deliveryId = 'bounce-delivery';
  await db.doc(`users/remind-guardian/notifications/bounce-note`).set({ ...meta, id: 'bounce-note', orgId: 'remind-org', recipientUid: 'remind-guardian', deliveryStatus: 'queued', critical: false, acknowledgedAt: null });
  await db.doc(`notificationDeliveries/${deliveryId}`).set({ ...meta, id: deliveryId, orgId: 'remind-org', channel: 'email', recipientUid: 'remind-guardian', notificationId: 'bounce-note',
    status: 'queued', templateKey: 'rsvpReminder', sourceType: 'event', sourceId: 'deadline-event', programId: 'remind-program', recipientEmail: 'secret@example.test' });
  assert.equal((await issues.recordNotificationEmailBounce(deliveryId, 'provider-event-1')).applied, true);
  assert.equal((await issues.recordNotificationEmailBounce(deliveryId, 'provider-event-1')).reason, 'duplicate');
  const token = 'ExponentPushToken[expiredtoken]';
  const pushId = 'expired-push';
  await db.doc('notificationEndpoints/remind-self_install-expired').set({ ...meta, userId: 'remind-self', installationId: 'install-expired', permissionState: 'granted', expoPushToken: token, revokedAt: null });
  await db.doc(`notificationDeliveries/${pushId}`).set({ ...meta, id: pushId, orgId: 'remind-org', channel: 'push', recipientUid: 'remind-self', notificationId: 'missing-push-note',
    status: 'providerAccepted', providerMessageId: 'receipt-1', nextReceiptAt: Timestamp.fromMillis(now), endpointId: 'remind-self_install-expired',
    endpointTokenFingerprint: fingerprint({ expoPushToken: token }), templateKey: 'rsvpReminder', sourceType: 'event', sourceId: 'deadline-event', programId: 'remind-program' });
  assert.equal(await worker.processPushReceipt(pushId, { async get() { return { outcome: 'permanent', errorCode: 'DeviceNotRegistered' }; } }, now + 1), 'permanentFailure');
  assert.equal((await db.doc('notificationEndpoints/remind-self_install-expired').get()).data().expoPushToken, null);
  const open = await call('remind-admin', 'listDeliveryDiagnostics', { orgId: 'remind-org' });
  const serialized = JSON.stringify(open);
  assert.equal(serialized.includes('secret@example.test'), false); assert.equal(serialized.includes('ExponentPushToken'), false); assert.equal(serialized.includes('remind-guardian'), false);
  assert.ok(open.failures.items.some(row => row.failureCode === 'EMAIL_BOUNCED' && row.id === deliveryId));
  assert.ok(open.failures.items.some(row => row.failureCode === 'DeviceNotRegistered' && row.id === pushId));
  assert.equal(open.failures.items.some(row => row.id === inbox.id), false);
  assert.ok(open.unacknowledged.items.some(row => row.id === inbox.id && row.title === 'Schedule changed'));
  assert.equal(open.unacknowledged.items.some(row => row.failureCode), false);
  const page = await call('remind-admin', 'listDeliveryDiagnostics', { orgId: 'remind-org', pageSize: 1 });
  assert.equal(page.failures.items.length, 1); assert.ok(page.failures.nextCursor);
  const acked = await call('remind-guardian', 'acknowledgeCriticalUpdate', { notificationId: inbox.id, sourceRevision: 2, requestId: 'remind-ack' });
  assert.ok(acked.acknowledgedAt);
  const after = await call('remind-admin', 'listDeliveryDiagnostics', { orgId: 'remind-org', pageSize: 50 });
  assert.equal(after.unacknowledged.items.some(row => row.id === inbox.id), false);
  assert.ok(after.failures.items.some(row => row.failureCode === 'EMAIL_BOUNCED'));
  await assert.rejects(call('remind-outsider', 'listDeliveryDiagnostics', { orgId: 'remind-org' }), { code: 'functions/permission-denied' });
  await assert.rejects(call('remind-coach', 'listDeliveryDiagnostics', { orgId: 'remind-org' }), { code: 'functions/permission-denied' });
  const hidden = await call('remind-staff', 'listDeliveryDiagnostics', { orgId: 'remind-org' });
  assert.deepEqual(hidden.failures.items, []); assert.deepEqual(hidden.unacknowledged.items, []);
  await db.doc('organizations/remind-org/members/remind-staff').update({ programIds: ['remind-program'] });
  const visible = await call('remind-staff', 'listDeliveryDiagnostics', { orgId: 'remind-org' });
  assert.ok(visible.failures.items.some(row => row.failureCode === 'EMAIL_BOUNCED'));
  await db.doc('organizations/remind-org/members/remind-staff').update({ programIds: ['other-program'] });
});

test('a pending reminder does not expand after it stops being eligible', async () => {
  const cancelled = 'stale-cancel-event';
  await db.doc(`events/${cancelled}`).set(event(cancelled, { deadlineMs: now + 6 * HOUR }));
  await reminders.dispatchRsvpReminder('remind-org', cancelled, now);
  const cancelIntent = (await intentsFor(cancelled)).docs[0];
  await db.doc(`events/${cancelled}`).update({ status: 'cancelled' });
  await worker.expandNotificationIntent('remind-org', cancelIntent.id);
  assert.equal((await db.collection('users/remind-guardian/notifications').where('sourceId', '==', cancelled).get()).size, 0);
  assert.equal((await db.doc(`organizations/remind-org/outbox/${cancelIntent.id}`).get()).data().state, 'expanded');

  const moved = 'stale-move-event';
  await db.doc(`events/${moved}`).set(event(moved, { deadlineMs: now + 6 * HOUR }));
  await reminders.dispatchRsvpReminder('remind-org', moved, now);
  const movedIntent = (await intentsFor(moved)).docs[0];
  await db.doc(`events/${moved}`).update({ rsvpDeadline: Timestamp.fromMillis(now + 10 * HOUR), scheduleVersion: 2 });
  await worker.expandNotificationIntent('remind-org', movedIntent.id);
  assert.equal((await db.collection('users/remind-self/notifications').where('sourceId', '==', moved).get()).size, 0);
  const replacement = await reminders.dispatchRsvpReminder('remind-org', moved, now);
  assert.equal(replacement.result, 'sent');
  const fresh = (await intentsFor(moved)).docs.find(doc => doc.id !== movedIntent.id);
  await worker.expandNotificationIntent('remind-org', fresh.id);
  assert.equal((await db.collection('users/remind-self/notifications').where('sourceId', '==', moved).get()).size, 1);

  const flaggedId = 'stale-flag-event';
  await db.doc(`events/${flaggedId}`).set(event(flaggedId, { deadlineMs: now + 6 * HOUR }));
  await reminders.dispatchRsvpReminder('remind-org', flaggedId, now);
  const flaggedIntent = (await intentsFor(flaggedId)).docs[0];
  await db.doc('organizations/remind-org').update({ 'features.rsvpReminders': false });
  await worker.expandNotificationIntent('remind-org', flaggedIntent.id);
  assert.equal((await db.collection('users/remind-guardian/notifications').where('sourceId', '==', flaggedId).get()).size, 0);
  const disabled = await reminders.dispatchRsvpReminder('remind-org', flaggedId, now);
  assert.equal(disabled.result, 'disabled');
  await db.doc('organizations/remind-org').update({ 'features.rsvpReminders': true });

  const hidden = 'stale-hidden-event';
  await db.doc(`events/${hidden}`).set(event(hidden, { deadlineMs: now + 6 * HOUR }));
  await reminders.dispatchRsvpReminder('remind-org', hidden, now);
  const hiddenIntent = (await intentsFor(hidden)).docs[0];
  await db.doc(`events/${hidden}`).update({ publicationState: 'staged' });
  await worker.expandNotificationIntent('remind-org', hiddenIntent.id);
  assert.equal((await db.collection('users/remind-guardian/notifications').where('sourceId', '==', hidden).get()).size, 0);
});

test('a near deadline on a far event is prepared, including after the flag was off', async () => {
  const id = 'far-deadline-event';
  await db.doc('organizations/remind-org').update({ 'features.rsvpReminders': false });
  await db.doc(`events/${id}`).set(event(id, { startsAtMs: now + 20 * 7 * 24 * HOUR, deadlineMs: now + 20 * HOUR }));
  assert.equal((await reminders.syncRsvpReminder('remind-org', id, now)).state, 'paused');
  await db.doc('organizations/remind-org').update({ 'features.rsvpReminders': true });
  let reminder;
  for (let page = 0; page < 40 && reminder?.state !== 'scheduled'; page += 1) {
    await reminders.scanUpcomingReminders(now);
    reminder = (await db.doc(`organizations/remind-org/rsvpReminders/${id}`).get()).data();
  }
  assert.equal(reminder.state, 'scheduled');
  assert.equal(reminder.reason, 'immediate');
});

test('losing access removes a critical projection that has no delivery', async () => {
  await db.doc('organizations/remind-org').update({ 'features.notificationInboxFake': false, 'features.notificationPush': true });
  await db.doc('organizations/remind-org/outbox/critical-no-delivery').set({ ...meta, orgId: 'remind-org', sourceType: 'event', sourceId: 'critical-event', sourceRevision: 2,
    templateKey: 'event:cancel', critical: true, state: 'pending', programId: 'remind-program', audience: { teamIds: ['remind-team'] } });
  await worker.expandNotificationIntent('remind-org', 'critical-no-delivery');
  const note = (await db.collection('users/remind-guardian/notifications').where('templateKey', '==', 'event:cancel').get()).docs[0];
  assert.ok(note);
  assert.equal((await db.collection('notificationDeliveries').where('notificationId', '==', note.id).get()).size, 0);
  assert.equal((await db.doc(`organizations/remind-org/criticalUpdates/${note.id}`).get()).exists, true);
  await db.doc('organizations/remind-org/participants/remind-child/guardians/remind-guardian').update({ status: 'revoked' });
  await db.doc('organizations/remind-org/participants/remind-sibling/guardians/remind-guardian').update({ status: 'revoked' });
  await call('remind-guardian', 'listNotifications');
  assert.equal((await db.doc(`users/remind-guardian/notifications/${note.id}`).get()).exists, false);
  assert.equal((await db.doc(`organizations/remind-org/criticalUpdates/${note.id}`).get()).exists, false);
  await db.doc('organizations/remind-org/participants/remind-child/guardians/remind-guardian').update({ status: 'active' });
  await db.doc('organizations/remind-org/participants/remind-sibling/guardians/remind-guardian').update({ status: 'active' });
  await db.doc('organizations/remind-org').update({ 'features.notificationInboxFake': true, 'features.notificationPush': false });
});

test('account deletion removes reminder diagnostic rows for that person only', async () => {
  await db.doc('organizations/remind-org/deliveryIssues/delete-self').set({ ...meta, orgId: 'remind-org', recipientUid: 'remind-self', channel: 'email', status: 'permanentFailure', failureCode: 'EMAIL_BOUNCED' });
  await db.doc('organizations/remind-org/criticalUpdates/delete-self').set({ ...meta, orgId: 'remind-org', recipientUid: 'remind-self', title: 'Schedule changed', acknowledgedAt: null });
  await db.doc('organizations/remind-org/deliveryIssues/bounce-delivery').set({ recipientUid: 'remind-guardian' }, { merge: true });
  await deletion.beginDeletion('remind-self');
  const state = await deletion.resumeDeletion('remind-self');
  assert.equal(state.status, 'complete');
  assert.equal((await db.doc('organizations/remind-org/deliveryIssues/delete-self').get()).exists, false);
  assert.equal((await db.doc('organizations/remind-org/criticalUpdates/delete-self').get()).exists, false);
  assert.equal((await db.doc('organizations/remind-org/deliveryIssues/bounce-delivery').get()).exists, true);
});
