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
requireEmulators();
let admin, db; const apps = {};
const call = async (uid, name, data = {}) => (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const meta = { schemaVersion: 2, revision: 1, status: 'active', createdAt: Timestamp.now(), updatedAt: Timestamp.now() };
const intentPath = id => `organizations/notify-org/outbox/${id}`;
before(async () => {
  admin = adminApp({ projectId }); db = getFirestore(admin);
  for (const uid of ['notify-admin', 'notify-coach', 'notify-guardian', 'notify-self', 'notify-outsider']) {
    const app = initializeApp({ projectId, apiKey: 'demo-key' }, uid); apps[uid] = app;
    connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), '127.0.0.1', 5001);
    await adminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password: 'SyntheticPassword123!' });
    await db.doc(`users/${uid}`).set({ uid, appRole: 'user' });
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, 'SyntheticPassword123!');
  }
  await db.doc('organizations/notify-org').set({ ...meta, name: 'Synthetic league', features: { organizationV2: true, households: true, notificationInboxFake: true } });
  for (const [kind, id] of [['programs', 'notify-program'], ['seasons', 'notify-season'], ['divisions', 'notify-division']])
    await db.doc(`organizations/notify-org/${kind}/${id}`).set({ ...meta, orgId: 'notify-org', programId: 'notify-program', seasonId: 'notify-season', name: id });
  await db.doc('organizations/notify-org/members/notify-admin').set({ ...meta, orgId: 'notify-org', roles: ['orgAdmin'], programIds: [] });
  await db.doc('teams/notify-team').set({ ...meta, orgId: 'notify-org', programId: 'notify-program', seasonId: 'notify-season', divisionId: 'notify-division', name: 'Falcons' });
  await db.doc('teamMembers/notify-team_notify-coach').set({ ...meta, orgId: 'notify-org', teamId: 'notify-team', userId: 'notify-coach', roles: ['coach'] });
  await db.doc('organizations/notify-org/participants/notify-child').set({ ...meta, orgId: 'notify-org', displayName: 'Jamie', linkedUserId: 'notify-self' });
  await db.doc('organizations/notify-org/participants/notify-child/guardians/notify-guardian').set({ ...meta, orgId: 'notify-org', participantId: 'notify-child', userId: 'notify-guardian', permissions: { viewSchedule: true } });
  await db.doc('teams/notify-team/roster/notify-child').set({ ...meta, orgId: 'notify-org', participantId: 'notify-child' });
});
after(async () => { await Promise.all(Object.values(apps).map(deleteApp)); await deleteAdmin(admin); });

test('only deterministic audience validation errors permanently fail expansion', () => {
  const worker = require('./lib/notifications/worker.js');
  assert.equal(worker.permanentExpansionFailure(new Error('NOTIFICATION_AUDIENCE_TOO_LARGE')), 'NOTIFICATION_AUDIENCE_TOO_LARGE');
  assert.equal(worker.permanentExpansionFailure(new Error('UNAVAILABLE')), null);
});

test('duplicate unordered expansion creates one inbox row and one delivery per live recipient', async () => {
  await db.doc(intentPath('intent-1')).set({ ...meta, orgId: 'notify-org', sourceType: 'event', sourceId: 'event-1', sourceRevision: 2,
    templateKey: 'event:reschedule', critical: true, state: 'pending', audience: { teamIds: ['notify-team'] }, title: 'Schedule changed', body: 'Open Team Hangout for current details.' });
  const worker = require('./lib/notifications/worker.js');
  await Promise.all([worker.expandNotificationIntent('notify-org', 'intent-1'), worker.expandNotificationIntent('notify-org', 'intent-1')]);
  const recipients = ['notify-admin', 'notify-coach', 'notify-guardian', 'notify-self'];
  for (const uid of recipients) assert.equal((await db.collection(`users/${uid}/notifications`).get()).size, 1);
  assert.equal((await db.collection('notificationDeliveries').where('orgId', '==', 'notify-org').get()).size, recipients.length);
  assert.equal((await db.doc(intentPath('intent-1')).get()).data().state, 'expanded');
  assert.equal((await worker.expandNotificationIntent('notify-org', 'intent-1')).state, 'expanded');
});

test('send-time revocation cancels delivery and removes the in-app projection', async () => {
  const worker = require('./lib/notifications/worker.js');
  const delivery = (await db.collection('notificationDeliveries').where('recipientUid', '==', 'notify-guardian').get()).docs[0];
  await db.doc('organizations/notify-org/participants/notify-child/guardians/notify-guardian').update({ status: 'revoked' });
  assert.equal(await worker.processNotificationDelivery('notify-org', delivery.id, { provider: worker.fakeNotificationProvider('accepted') }), 'revoked');
  assert.equal((await delivery.ref.get()).data().status, 'permanentFailure');
  assert.equal((await db.collection('users/notify-guardian/notifications').get()).size, 0);
  assert.deepEqual((await call('notify-guardian', 'listNotifications')).items, []);
});

test('forged guardian metadata cannot preserve inbox access', async () => {
  const worker = require('./lib/notifications/worker.js');
  const grant = db.doc('organizations/notify-org/participants/notify-child/guardians/notify-guardian');
  await grant.update({ status: 'active', participantId: 'another-child' });
  assert.equal(await db.runTransaction(tx => worker.hasNotificationAccess(tx, 'notify-org', 'notify-guardian', [
    { kind: 'household', teamId: 'notify-team', participantId: 'notify-child' },
  ])), false);
  await grant.update({ participantId: 'notify-child' });
  await db.doc('organizations/notify-org').update({ status: 'archived' });
  assert.equal(await db.runTransaction(tx => worker.hasNotificationAccess(tx, 'notify-org', 'notify-guardian', [
    { kind: 'household', teamId: 'notify-team', participantId: 'notify-child' },
  ])), false);
  await db.doc('organizations/notify-org').update({ status: 'active' });
  await grant.update({ status: 'revoked' });
});

test('ambiguous provider result is never blindly retried after an expired lease', async () => {
  const worker = require('./lib/notifications/worker.js');
  const delivery = (await db.collection('notificationDeliveries').where('recipientUid', '==', 'notify-coach').get()).docs[0];
  assert.equal(await worker.processNotificationDelivery('notify-org', delivery.id, { provider: worker.fakeNotificationProvider('ambiguous') }), 'unknownOutcome');
  assert.equal((await delivery.ref.get()).data().status, 'unknownOutcome');
  assert.equal(await worker.processNotificationDelivery('notify-org', delivery.id, { provider: worker.fakeNotificationProvider('accepted') }), 'skipped');
  await delivery.ref.update({ status: 'sending', leaseUntil: Timestamp.fromMillis(Date.now() - 1), lease: 'lost-worker' });
  assert.equal(await worker.processNotificationDelivery('notify-org', delivery.id, { provider: worker.fakeNotificationProvider('accepted') }), 'unknownOutcome');
});

test('concurrent delivery tasks lease once and retryable failures back off before another attempt', async () => {
  const worker = require('./lib/notifications/worker.js');
  const selfDelivery = (await db.collection('notificationDeliveries').where('recipientUid', '==', 'notify-self').get()).docs[0];
  let sends = 0;
  const provider = { send: async () => { sends += 1; await new Promise(resolve => setTimeout(resolve, 25)); return 'accepted'; } };
  const outcomes = await Promise.all([worker.processNotificationDelivery('notify-org', selfDelivery.id, { provider }), worker.processNotificationDelivery('notify-org', selfDelivery.id, { provider })]);
  assert.deepEqual(outcomes.sort(), ['providerAccepted', 'skipped']); assert.equal(sends, 1);
  const adminDelivery = (await db.collection('notificationDeliveries').where('recipientUid', '==', 'notify-admin').get()).docs[0];
  const now = Date.now();
  assert.equal(await worker.processNotificationDelivery('notify-org', adminDelivery.id, { now, provider: worker.fakeNotificationProvider('retryable') }), 'retryableFailure');
  assert.equal(await worker.processNotificationDelivery('notify-org', adminDelivery.id, { now: now + 1, provider: worker.fakeNotificationProvider('accepted') }), 'skipped');
  assert.equal(await worker.processNotificationDelivery('notify-org', adminDelivery.id, { now: now + 3_700_000, provider: worker.fakeNotificationProvider('accepted') }), 'providerAccepted');
});

test('the fifth retryable provider result becomes a terminal failure', async () => {
  const worker = require('./lib/notifications/worker.js');
  const ref = db.collection('notificationDeliveries').doc('retry-limit');
  const notification = db.collection('users/notify-admin/notifications').doc('retry-limit');
  await notification.set({ ...meta, id: notification.id, orgId: 'notify-org', recipientUid: 'notify-admin', deliveryStatus: 'queued' });
  await ref.set({ ...meta, id: ref.id, orgId: 'notify-org', recipientUid: 'notify-admin', notificationId: notification.id,
    status: 'retryableFailure', attemptCount: 4, nextAttemptAt: Timestamp.fromMillis(0), accessSources: [{ kind: 'staff', programId: 'notify-program' }] });
  assert.equal(await worker.processNotificationDelivery('notify-org', ref.id, { provider: worker.fakeNotificationProvider('retryable') }), 'permanentFailure');
  assert.equal((await ref.get()).data().failureCode, 'RETRY_LIMIT_REACHED');
  assert.equal((await notification.get()).data().deliveryStatus, 'permanentFailure');
});

test('read and acknowledgement remain distinct and acknowledgements bind the source revision', async () => {
  const inbox = (await call('notify-self', 'listNotifications')).items[0];
  assert.equal(inbox.readAt, null); assert.equal(inbox.acknowledgedAt, null); assert.equal(inbox.deliveryStatus, 'providerAccepted');
  const read = await call('notify-self', 'markNotificationRead', { notificationId: inbox.id, sourceRevision: 2, requestId: 'read-1' });
  assert.ok(read.readAt); assert.equal(read.acknowledgedAt, null);
  await assert.rejects(call('notify-self', 'acknowledgeCriticalUpdate', { notificationId: inbox.id, sourceRevision: 1, requestId: 'ack-old' }), error => error.details.domainCode === 'STALE_REVISION');
  const ack = await call('notify-self', 'acknowledgeCriticalUpdate', { notificationId: inbox.id, sourceRevision: 2, requestId: 'ack-current' });
  assert.ok(ack.readAt); assert.ok(ack.acknowledgedAt);
  await assert.rejects(call('notify-outsider', 'markNotificationRead', { notificationId: inbox.id, sourceRevision: 2, requestId: 'steal' }), { code: 'functions/permission-denied' });
});
