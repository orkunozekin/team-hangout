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
    await db.doc(`users/${uid}`).set({ uid, email: `${uid}@example.test`, appRole: 'user' });
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
  const history = db.batch();
  for (let i = 0; i < 101; i++) {
    history.set(db.doc(`organizations/notify-org/members/revoked-${i}`), { ...meta, orgId: 'notify-org', status: 'revoked', roles: ['orgAdmin'], programIds: [] });
    history.set(db.doc(`teamMembers/notify-team_revoked-${i}`), { ...meta, orgId: 'notify-org', teamId: 'notify-team', userId: `revoked-${i}`, status: 'revoked', roles: ['coach'] });
  }
  await history.commit();
  await db.doc(intentPath('intent-1')).set({ ...meta, orgId: 'notify-org', sourceType: 'event', sourceId: 'event-1', sourceRevision: 2,
    templateKey: 'event:reschedule', critical: true, state: 'pending', audience: { teamIds: ['notify-team'] }, title: 'Schedule changed', body: 'Open Team Hangout for current details.' });
  const worker = require('./lib/notifications/worker.js');
  await Promise.all([worker.expandNotificationIntent('notify-org', 'intent-1'), worker.expandNotificationIntent('notify-org', 'intent-1')]);
  const recipients = ['notify-admin', 'notify-coach', 'notify-guardian', 'notify-self'];
  for (const uid of recipients) assert.equal((await db.collection(`users/${uid}/notifications`).get()).size, 1);
  assert.equal((await db.collection('notificationDeliveries').where('orgId', '==', 'notify-org').get()).size, recipients.length);
  assert.equal((await db.doc(intentPath('intent-1')).get()).data().state, 'expanded');
  assert.equal((await worker.expandNotificationIntent('notify-org', 'intent-1')).state, 'expanded');
  const cleanup = db.batch();
  for (let i = 0; i < 101; i++) {
    cleanup.delete(db.doc(`organizations/notify-org/members/revoked-${i}`)); cleanup.delete(db.doc(`teamMembers/notify-team_revoked-${i}`));
  }
  await cleanup.commit();
});

test('page authorization batches and reuses shared authority documents', async () => {
  const worker = require('./lib/notifications/worker.js');
  await db.runTransaction(async tx => {
    let getAllCalls = 0, referencedDocuments = 0;
    const instrumented = Object.create(tx);
    instrumented.getAll = async (...refs) => { getAllCalls += 1; referencedDocuments += refs.length; return tx.getAll(...refs); };
    const rows = Array.from({ length: 50 }, () => ({ orgId: 'notify-org', accessSources: [
      { kind: 'household', teamId: 'notify-team', participantId: 'notify-child' },
    ] }));
    assert.ok((await worker.authorizeNotificationRows(instrumented, 'notify-self', rows)).every(Boolean));
    assert.equal(getAllCalls, 2); assert.equal(referencedDocuments, 7);
  });
});

test('an access-check outage releases the unsent lease for retry without consuming an attempt', async () => {
  const worker = require('./lib/notifications/worker.js'), ref = db.collection('notificationDeliveries').doc('access-outage');
  await ref.set({ ...meta, id: ref.id, orgId: 'notify-org', recipientUid: 'notify-self', notificationId: 'missing-projection',
    status: 'queued', attemptCount: 0, nextAttemptAt: Timestamp.fromMillis(0), accessSources: [{ kind: 'household', teamId: 'notify-team', participantId: 'notify-child' }] });
  let sends = 0;
  assert.equal(await worker.processNotificationDelivery('notify-org', ref.id, { now: 1000,
    authorize: async () => { throw new Error('UNAVAILABLE'); }, provider: { send: async () => { sends += 1; return 'accepted'; } } }), 'retryableFailure');
  const row = (await ref.get()).data();
  assert.equal(sends, 0); assert.equal(row.status, 'retryableFailure'); assert.equal(row.attemptCount, 0); assert.equal(row.failureCode, 'ACCESS_CHECK_RETRY');
  assert.ok(row.nextAttemptAt.toMillis() > 1000);
  await ref.delete();
});

test('disabled organizations pause due deliveries outside the global due queue', async () => {
  const worker = require('./lib/notifications/worker.js'), ref = db.collection('notificationDeliveries').doc('disabled-delivery');
  const notification = db.doc('users/notify-self/notifications/disabled-projection');
  await notification.set({ ...meta, id: notification.id, deliveryStatus: 'queued' });
  await ref.set({ ...meta, id: ref.id, orgId: 'notify-org', recipientUid: 'notify-self', notificationId: 'missing-projection',
    status: 'queued', attemptCount: 0, nextAttemptAt: Timestamp.fromMillis(0), accessSources: [{ kind: 'household', teamId: 'notify-team', participantId: 'notify-child' }] });
  await ref.update({ notificationId: notification.id });
  await db.doc('organizations/notify-org').update({ 'features.notificationInboxFake': false });
  assert.equal(await worker.processNotificationDelivery('notify-org', ref.id), 'disabled');
  const row = (await ref.get()).data();
  assert.equal(row.status, 'paused'); assert.equal(row.failureCode, 'FEATURE_DISABLED'); assert.equal(row.nextAttemptAt, null);
  assert.equal((await notification.get()).data().deliveryStatus, 'paused');
  await db.doc('organizations/notify-org').update({ 'features.notificationInboxFake': true });
  await Promise.all([ref.delete(), notification.delete()]);
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
  await db.doc('organizations/notify-org').update({ 'features.households': false });
  assert.equal(await db.runTransaction(tx => worker.hasNotificationAccess(tx, 'notify-org', 'notify-self', [
    { kind: 'household', teamId: 'notify-team', participantId: 'notify-child' },
  ])), false);
  await db.doc('organizations/notify-org').update({ 'features.households': true });
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

test('push device lifecycle is self-only, validates tokens and records denied permission without a token', async () => {
  const denied = await call('notify-self', 'registerPushDevice', { requestId: 'push-denied', installationId: 'install-a', platform: 'ios',
    projectId: 'project-a', permissionState: 'denied', expoPushToken: null });
  assert.equal(denied.permissionState, 'denied');
  assert.equal((await db.doc('notificationEndpoints/notify-self_install-a').get()).data().expoPushToken, null);
  await assert.rejects(call('notify-self', 'registerPushDevice', { requestId: 'push-bad', installationId: 'install-a', platform: 'ios',
    projectId: 'project-a', permissionState: 'granted', expoPushToken: 'not-a-token' }), { code: 'functions/invalid-argument' });
  const granted = await call('notify-self', 'registerPushDevice', { requestId: 'push-granted', installationId: 'install-a', platform: 'ios',
    projectId: 'project-a', permissionState: 'granted', expoPushToken: 'ExponentPushToken[test-token]' });
  assert.equal(granted.permissionState, 'granted');
  assert.equal((await db.doc('notificationEndpoints/notify-self_install-a').get()).data().expoPushToken, 'ExponentPushToken[test-token]');
  await call('notify-coach', 'registerPushDevice', { requestId: 'push-account-switch', installationId: 'install-coach', platform: 'ios',
    projectId: 'project-a', permissionState: 'granted', expoPushToken: 'ExponentPushToken[test-token]' });
  assert.equal((await db.doc('notificationEndpoints/notify-self_install-a').get()).data().permissionState, 'revoked');
  await call('notify-self', 'revokePushDevice', { requestId: 'push-revoke', installationId: 'install-a' });
  assert.ok((await db.doc('notificationEndpoints/notify-self_install-a').get()).data().revokedAt);
});

test('notification targets are resolved after live authorization and disappear after revocation', async () => {
  const inbox = (await call('notify-self', 'listNotifications')).items[0];
  const resolved = await call('notify-self', 'resolveNotificationTarget', { notificationId: inbox.id, sourceRevision: inbox.sourceRevision });
  assert.deepEqual(resolved, { available: true, target: { type: 'event', id: 'event-1' } });
  await db.doc('organizations/notify-org/participants/notify-child').update({ linkedUserId: null });
  const unavailable = await call('notify-self', 'resolveNotificationTarget', { notificationId: inbox.id, sourceRevision: inbox.sourceRevision });
  assert.deepEqual(unavailable, { available: false, target: null });
  await db.doc('organizations/notify-org/participants/notify-child').update({ linkedUserId: 'notify-self' });
});

test('provider flags create bounded push delivery with email fallback and poll receipts separately from human reads', async () => {
  await db.doc('organizations/notify-org').update({ 'features.notificationPush': true, 'features.notificationEmailFallback': true });
  await db.doc('notificationEndpoints/notify-self_install-b').set({ ...meta, userId: 'notify-self', installationId: 'install-b', platform: 'ios',
    projectId: 'project-a', permissionState: 'granted', expoPushToken: 'ExponentPushToken[second-token]', revokedAt: null });
  await db.doc(intentPath('intent-provider')).set({ ...meta, orgId: 'notify-org', sourceType: 'event', sourceId: 'event-provider', sourceRevision: 5,
    templateKey: 'event:edit', critical: false, state: 'pending', audience: { teamIds: ['notify-team'] } });
  const worker = require('./lib/notifications/worker.js');
  await worker.expandNotificationIntent('notify-org', 'intent-provider');
  const push = (await db.collection('notificationDeliveries').where('intentId', '==', 'intent-provider').where('channel', '==', 'push').get()).docs;
  assert.equal(push.length, 2); const selfPush = push.find(doc => doc.data().recipientUid === 'notify-self'); assert.ok(selfPush);
  const emails = (await db.collection('notificationDeliveries').where('intentId', '==', 'intent-provider').where('channel', '==', 'email').get()).docs;
  assert.deepEqual(emails.map(doc => doc.data().recipientUid).sort(), ['notify-admin']);
  const deliveryNow = Date.now() + 1000;
  assert.equal(await worker.processNotificationDelivery('notify-org', selfPush.id, { now: deliveryNow,
    provider: { send: async () => ({ outcome: 'accepted', messageId: 'ticket-1' }) } }), 'providerAccepted');
  await selfPush.ref.update({ nextReceiptAt: Timestamp.fromMillis(0) });
  assert.equal(await worker.processPushReceipt(selfPush.id, { get: async () => ({ outcome: 'ok' }) }, deliveryNow + 16 * 60_000), 'providerReceiptOk');
  const projection = (await db.doc(`users/notify-self/notifications/${selfPush.data().notificationId}`).get()).data();
  assert.equal(projection.readAt, null); assert.equal(projection.acknowledgedAt, null);
});

test('device-not-registered receipt revokes only that endpoint and queues deterministic email fallback', async () => {
  const worker = require('./lib/notifications/worker.js');
  const push = (await db.collection('notificationDeliveries').where('intentId', '==', 'intent-provider').where('channel', '==', 'push').get()).docs
    .find(doc => doc.data().recipientUid === 'notify-self'); assert.ok(push);
  await push.ref.update({ status: 'providerAccepted', providerMessageId: 'ticket-2', nextReceiptAt: Timestamp.fromMillis(0) });
  let receiptCalls = 0;
  const receipt = { get: async () => { receiptCalls += 1; await new Promise(resolve => setTimeout(resolve, 25));
    return { outcome: 'permanent', errorCode: 'DeviceNotRegistered' }; } };
  assert.deepEqual((await Promise.all([worker.processPushReceipt(push.id, receipt), worker.processPushReceipt(push.id, receipt)])).sort(),
    ['permanentFailure', 'skipped']);
  assert.equal(receiptCalls, 1);
  const endpoint = (await db.doc('notificationEndpoints/notify-self_install-b').get()).data();
  assert.equal(endpoint.permissionState, 'revoked'); assert.equal(endpoint.expoPushToken, null);
  const fallback = await db.collection('notificationDeliveries').where('intentId', '==', 'intent-provider').where('recipientUid', '==', 'notify-self').where('channel', '==', 'email').get();
  assert.equal(fallback.size, 1); assert.equal(fallback.docs[0].data().status, 'queued');
  await fallback.docs[0].ref.update({ status: 'providerAccepted' });
  await push.ref.update({ status: 'providerAccepted', nextReceiptAt: Timestamp.fromMillis(0) });
  assert.equal(await worker.processPushReceipt(push.id, receipt), 'permanentFailure');
  assert.equal((await fallback.docs[0].ref.get()).data().status, 'providerAccepted');
});

test('Expo adapters keep payload navigation allowlisted and classify tickets and receipts', async () => {
  const providers = require('./lib/notifications/providers.js');
  const previous = process.env.PUSH_DELIVERY_ENABLED; process.env.PUSH_DELIVERY_ENABLED = 'true';
  let request;
  const response = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const push = providers.expoPushProvider(async (_url, options) => { request = JSON.parse(options.body); return response({ data: { status: 'ok', id: 'ticket-3' } }); });
  assert.deepEqual(await push.send({ endpointToken: 'ExponentPushToken[x]', notificationId: 'notice-safe', sourceRevision: 7,
    title: 'Team update', body: 'Open Team Hangout for current details.' }), { outcome: 'accepted', messageId: 'ticket-3' });
  assert.equal(request.data.url, 'teamhangout://notification?id=notice-safe&revision=7');
  assert.equal(request.body, 'Open Team Hangout for current details.');
  const receipts = providers.expoReceiptProvider(async () => response({ data: { 'ticket-3': { status: 'error', details: { error: 'DeviceNotRegistered' } } } }));
  assert.deepEqual(await receipts.get('ticket-3'), { outcome: 'permanent', errorCode: 'DeviceNotRegistered' });
  if (previous == null) delete process.env.PUSH_DELIVERY_ENABLED; else process.env.PUSH_DELIVERY_ENABLED = previous;
});

test('email fallback uses the isolated mailbox only for the verified current account address', async () => {
  const providers = require('./lib/notifications/providers.js');
  const previous = { emulator: process.env.FUNCTIONS_EMULATOR, project: process.env.GCLOUD_PROJECT, enabled: process.env.NOTIFICATION_EMAIL_ENABLED };
  process.env.FUNCTIONS_EMULATOR = 'true'; process.env.GCLOUD_PROJECT = 'demo-team-hangout'; process.env.NOTIFICATION_EMAIL_ENABLED = 'true';
  await adminAuth(admin).updateUser('notify-admin', { emailVerified: true });
  const provider = providers.notificationEmailProvider(); assert.ok(provider);
  const delivery = { id: 'email-provider-test', recipientUid: 'notify-admin', recipientEmail: 'notify-admin@example.test',
    notificationId: 'notice-email', sourceRevision: 3, title: 'Team update', body: 'Open Team Hangout for current details.' };
  const result = await provider.send(delivery);
  assert.equal(result.outcome, 'accepted');
  const mailbox = (await db.doc('developmentMailbox/notification-email-provider-test').get()).data();
  assert.equal(mailbox.to, 'notify-admin@example.test');
  assert.match(mailbox.text, /teamhangout:\/\/notification\?id=notice-email&revision=3/);
  assert.doesNotMatch(mailbox.text, /Jamie|Falcons/);
  assert.equal((await provider.send({ ...delivery, id: 'wrong-email', recipientEmail: 'other@example.test' })).outcome, 'permanent');
  if (previous.emulator == null) delete process.env.FUNCTIONS_EMULATOR; else process.env.FUNCTIONS_EMULATOR = previous.emulator;
  if (previous.project == null) delete process.env.GCLOUD_PROJECT; else process.env.GCLOUD_PROJECT = previous.project;
  if (previous.enabled == null) delete process.env.NOTIFICATION_EMAIL_ENABLED; else process.env.NOTIFICATION_EMAIL_ENABLED = previous.enabled;
});

test('a revoked row at the page boundary leaves a usable cursor for older notifications', async () => {
  const collection = db.collection('users/notify-self/notifications'), revoked = collection.doc('cursor-revoked'), older = collection.doc('cursor-older');
  await revoked.set({ ...meta, id: revoked.id, orgId: 'notify-org', recipientUid: 'notify-self', title: 'Revoked', body: 'Hidden', critical: false,
    sourceType: 'event', sourceId: 'gone', sourceRevision: 1, createdAt: Timestamp.fromMillis(9_999_999_999_000), readAt: null, acknowledgedAt: null,
    deliveryStatus: 'queued', accessSources: [{ kind: 'household', teamId: 'notify-team', participantId: 'missing' }] });
  await older.set({ ...meta, id: older.id, orgId: 'notify-org', recipientUid: 'notify-self', title: 'Older', body: 'Visible', critical: false,
    sourceType: 'event', sourceId: 'event-older', sourceRevision: 1, createdAt: Timestamp.fromMillis(9_999_999_998_000), readAt: null, acknowledgedAt: null,
    deliveryStatus: 'queued', accessSources: [{ kind: 'household', teamId: 'notify-team', participantId: 'notify-child' }] });
  const first = await call('notify-self', 'listNotifications', { pageSize: 1 });
  assert.deepEqual(first.items, []); assert.equal(first.nextCursor, revoked.id); assert.equal((await revoked.get()).exists, true);
  const second = await call('notify-self', 'listNotifications', { pageSize: 1, cursor: first.nextCursor });
  assert.equal(second.items[0].id, older.id);
  await Promise.all([revoked.delete(), older.delete()]);
});

test('inbox pages stop at a bounded union of access sources without skipping older rows', async () => {
  const collection = db.collection('users/notify-outsider/notifications'), refs = [];
  for (let page = 0; page < 3; page++) {
    const ref = collection.doc(`bounded-${page}`); refs.push(ref);
    await ref.set({ ...meta, id: ref.id, orgId: 'notify-org', recipientUid: 'notify-outsider', title: 'Hidden', body: 'Hidden', critical: false,
      sourceType: 'event', sourceId: `bounded-${page}`, sourceRevision: 1, createdAt: Timestamp.fromMillis(8_000_000_000_000 - page),
      readAt: null, acknowledgedAt: null, deliveryStatus: 'queued', accessSources: Array.from({ length: 50 }, (_, index) => (
        { kind: 'household', teamId: `missing-${page}-${index}`, participantId: `missing-${page}-${index}` })) });
  }
  const first = await call('notify-outsider', 'listNotifications', { pageSize: 50 });
  assert.deepEqual(first.items, []); assert.equal(first.nextCursor, refs[1].id);
  const second = await call('notify-outsider', 'listNotifications', { pageSize: 50, cursor: first.nextCursor });
  assert.deepEqual(second.items, []); assert.equal(second.nextCursor, null);
  await Promise.all(refs.map(ref => ref.delete()));
});
