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
const { getStorage } = require('firebase-admin/storage');
const {
  ATTACHMENT_MAX_BYTES, ATTACHMENT_QUARANTINE_TTL_MS, contentScanner, reviewAttachment, selectAttachmentScanner, sha256,
} = require('./lib/communications/attachmentScan.js');
const { purgeAbandonedAttachments, attachmentTransport } = require('./lib/communications/attachments.js');
const { PILOT_ROLLBACK_CONFIRM, PILOT_WRITER_FLAGS, PILOT_FUNCTION_MEMORY } = require('./lib/operations/pilot.js');
requireEmulators();

const exif = Buffer.concat([Buffer.from('Exif\0\0'), Buffer.from('GPS-SYNTHETIC')]);
const exifLength = Buffer.alloc(2);
exifLength.writeUInt16BE(exif.length + 2);
const jpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe1]), exifLength, exif,
  Buffer.from('ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda000800010100003f007f00ffd9', 'hex'),
]);
const cleaned = contentScanner({ bytes: jpeg, detectedType: 'image/jpeg' });
if (cleaned.verdict !== 'clean') throw new Error('Synthetic JPEG was not accepted by the content scanner.');
const cleanedJpeg = cleaned.bytes;
const orgId = 'p220-org';
const scope = { orgId, programId: 'p220-program', seasonId: 'p220-season', divisionId: 'p220-division' };
const team = { orgId, scopeType: 'team', scopeId: 'p220-a' };
const meta = { schemaVersion: 2, revision: 1, status: 'active', createdAt: Timestamp.now(), updatedAt: Timestamp.now() };
const transport = 'http://127.0.0.1:5001/demo-team-hangout/us-central1/attachmentTransport';
const users = ['p220-admin', 'p220-staff', 'p220-revoked', 'p220-coach', 'p220-other-coach', 'p220-parent1', 'p220-parent2', 'p220-viewer', 'p220-self', 'p220-outsider', 'p220-foreign'];
let admin, db, sequence = 0;
const apps = {};
const call = async (uid, name, data = {}) => (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const fail = async (uid, name, data = {}) => { try { await call(uid, name, data); assert.fail('expected rejection'); } catch (error) { return error; } };
const rid = () => `p220-${++sequence}`;

async function putBytes(token, bytes) {
  return fetch(transport, { method: 'PUT', headers: { Authorization: `Attachment ${token}`, 'Content-Type': 'image/jpeg' }, body: bytes });
}
async function download(uid, attachmentId) {
  const idToken = await getAuth(apps[uid]).currentUser.getIdToken();
  return fetch(transport, {
    headers: {
      Authorization: `Bearer ${idToken}`,
      'X-Org-Id': orgId,
      'X-Scope-Type': 'team',
      'X-Scope-Id': 'p220-a',
      'X-Attachment-Id': attachmentId,
    },
  });
}

before(async () => {
  admin = adminApp({ projectId }, 'pilot-admin');
  db = getFirestore(admin);
  for (const uid of users) {
    const app = initializeApp({ projectId, apiKey: 'demo-key' }, uid);
    apps[uid] = app;
    connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), '127.0.0.1', 5001);
    await adminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password: 'SyntheticPassword123!' });
    await db.doc(`users/${uid}`).set({ uid, email: `${uid}@example.test`, appRole: 'user' });
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, 'SyntheticPassword123!');
  }
  await db.doc(`organizations/${orgId}`).set({
    ...meta, ...scope, name: 'Synthetic Pilot',
    features: {
      organizationV2: true, adminWorkspace: true, households: true, scheduler: true, attendance: true,
      locationAssistance: true, conversations: true, attachments: true, rsvpReminders: true,
      notificationInboxFake: true, notificationPush: true, notificationEmailFallback: true,
    },
    policies: { youthChannels: 'approved' },
  });
  await db.doc('organizations/p220-other').set({ ...meta, name: 'Other league', features: { organizationV2: true, adminWorkspace: true } });
  for (const [kind, name] of [['programs', scope.programId], ['seasons', scope.seasonId], ['divisions', scope.divisionId]]) {
    await db.doc(`organizations/${orgId}/${kind}/${name}`).set({ ...meta, ...scope, name });
  }
  await db.doc(`organizations/${orgId}/members/p220-admin`).set({ ...meta, orgId, roles: ['orgAdmin'], programIds: [] });
  await db.doc(`organizations/${orgId}/members/p220-staff`).set({ ...meta, orgId, roles: ['programStaff'], programIds: [scope.programId] });
  await db.doc(`organizations/${orgId}/members/p220-revoked`).set({ ...meta, orgId, roles: ['orgAdmin'], programIds: [], status: 'revoked' });
  await db.doc('organizations/p220-other/members/p220-foreign').set({ ...meta, orgId: 'p220-other', roles: ['orgAdmin'], programIds: [] });
  for (const teamId of ['p220-a', 'p220-b']) await db.doc(`teams/${teamId}`).set({ ...meta, ...scope, name: teamId });
  await db.doc('teamMembers/p220-a_p220-coach').set({ ...meta, orgId, teamId: 'p220-a', userId: 'p220-coach', roles: ['coach'] });
  await db.doc('teamMembers/p220-b_p220-other-coach').set({ ...meta, orgId, teamId: 'p220-b', userId: 'p220-other-coach', roles: ['coach'] });
  await db.doc(`organizations/${orgId}/participants/p220-child-a`).set({ ...meta, orgId, displayName: 'Child A', kind: 'adult', linkedUserId: 'p220-self' });
  await db.doc(`organizations/${orgId}/participants/p220-child-b`).set({ ...meta, orgId, displayName: 'Child B', kind: 'adult', linkedUserId: null });
  await db.doc('teams/p220-a/roster/p220-child-a').set({ ...meta, orgId, participantId: 'p220-child-a' });
  await db.doc('teams/p220-b/roster/p220-child-b').set({ ...meta, orgId, participantId: 'p220-child-b' });
  for (const uid of ['p220-parent1', 'p220-parent2']) {
    await db.doc(`organizations/${orgId}/participants/p220-child-a/guardians/${uid}`).set({
      ...meta, orgId, participantId: 'p220-child-a', userId: uid,
      permissions: { viewSchedule: true, viewProfile: true, respond: true },
    });
  }
  await db.doc(`organizations/${orgId}/participants/p220-child-a/guardians/p220-viewer`).set({
    ...meta, orgId, participantId: 'p220-child-a', userId: 'p220-viewer',
    permissions: { viewSchedule: true, viewProfile: true, respond: false },
  });
  await db.doc(`organizations/${orgId}/participants/p220-child-b/guardians/p220-parent2`).set({
    ...meta, orgId, participantId: 'p220-child-b', userId: 'p220-parent2',
    permissions: { viewSchedule: true, viewProfile: true, respond: true },
  });
});
after(async () => {
  await Promise.all(Object.values(apps).map((app) => deleteApp(app)));
  if (admin) await deleteAdmin(admin);
});

test('scanner kill switch, external outage, and grant expiry stay fail-closed', async () => {
  const config = db.doc('platformConfig/attachmentScanner');
  try {
    await config.set({ mode: 'unavailable' });
    const grant = await call('p220-coach', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'kill.jpg', declaredBytes: jpeg.length });
    assert.equal((await putBytes(grant.token, jpeg)).status, 200);
    const failed = await call('p220-coach', 'finalizeAttachment', { requestId: rid(), ...team, attachmentId: grant.id });
    assert.equal(failed.state, 'rejected');
    assert.equal(failed.rejectionCode, 'SCAN_FAILED');
    assert.notEqual(failed.rejectionCode, 'INTEGRITY');
    assert.notEqual(failed.rejectionCode, 'ACCESS_REVOKED');
  } finally {
    await config.delete();
  }
  const external = selectAttachmentScanner({ mode: 'external', externalUrl: 'https://scanner.invalid/scan' }, async () => {
    throw new Error('connection refused');
  });
  const outage = await reviewAttachment({
    fileName: 'outage.jpg', declaredBytes: cleanedJpeg.length, bytes: cleanedJpeg,
    expiresAtMs: Date.now() + 60000, nowMs: Date.now(), scanner: external.scan, scannerName: external.name,
  });
  assert.equal(outage.state, 'rejected');
  assert.equal(outage.code, 'SCAN_FAILED');
  const missing = await call('p220-coach', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'expired.jpg', declaredBytes: jpeg.length });
  assert.equal((await putBytes(missing.token, jpeg)).status, 200);
  await db.doc(`organizations/${orgId}/attachments/${missing.id}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
  const expired = await call('p220-coach', 'finalizeAttachment', { requestId: rid(), ...team, attachmentId: missing.id });
  assert.equal(expired.rejectionCode, 'EXPIRED');
  const late = await call('p220-coach', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'late.jpg', declaredBytes: jpeg.length });
  assert.equal((await putBytes(late.token, jpeg)).status, 200);
  const canonicalPath = `quarantine/${orgId}/${late.id}/2`;
  await getStorage(admin).bucket(`${projectId}.appspot.com`).file(canonicalPath).save(cleanedJpeg, { resumable: false });
  await db.doc(`organizations/${orgId}/attachments/${late.id}`).update({
    state: 'canonicalizing', canonicalSha256: sha256(cleanedJpeg), canonicalBytes: cleanedJpeg.length, expiresAt: Timestamp.fromMillis(Date.now() - 1000),
  });
  const done = await call('p220-coach', 'finalizeAttachment', { requestId: rid(), ...team, attachmentId: late.id });
  assert.equal(done.state, 'ready');
  assert.equal(done.byteLength, cleanedJpeg.length);
  const downloaded = await download('p220-coach', late.id);
  assert.equal(downloaded.status, 200);
  assert.equal(Buffer.compare(Buffer.from(await downloaded.arrayBuffer()), cleanedJpeg), 0);
});

test('purge resumes from the saved page token across both object generations', async () => {
  const bucket = getStorage(admin).bucket(`${projectId}.appspot.com`);
  for (let index = 0; index < 2; index += 1) {
    await bucket.file(`quarantine/000/pilot-pad-${index}/1`).save(Buffer.from(`pad-${index}`));
  }
  const canonicalOrphan = `quarantine/${orgId}/pilot-late-canonical/2`;
  const readyCanonical = `quarantine/${orgId}/pilot-kept-canonical/2`;
  const staleUpload = `quarantine/${orgId}/pilot-kept-canonical/1`;
  await bucket.file(canonicalOrphan).save(Buffer.from('late-canonical'));
  await bucket.file(readyCanonical).save(Buffer.from('kept-canonical'));
  await bucket.file(staleUpload).save(Buffer.from('stale-upload'));
  await db.doc(`organizations/${orgId}/attachments/pilot-kept-canonical`).set({
    state: 'ready', objectPath: readyCanonical, createdAt: Timestamp.fromMillis(Date.now() - ATTACHMENT_QUARANTINE_TTL_MS - 5000),
  });
  await db.doc('platformConfig/attachmentPurge').set({ objectPageToken: null }, { merge: true });
  const aged = new Set([canonicalOrphan, readyCanonical, staleUpload]);
  const options = {
    db, bucket, objectPages: 1, objectPageSize: 1,
    objectTimeMs: (name, created) => aged.has(name) ? Date.now() - ATTACHMENT_QUARANTINE_TTL_MS - 1000 : created,
  };
  await purgeAbandonedAttachments(Date.now(), options);
  const firstToken = (await db.doc('platformConfig/attachmentPurge').get()).data().objectPageToken;
  assert.equal(typeof firstToken, 'string');
  let canonicalRemoved = false;
  let staleRemoved = false;
  for (let attempt = 0; attempt < 80 && (!canonicalRemoved || !staleRemoved); attempt += 1) {
    await purgeAbandonedAttachments(Date.now(), options);
    canonicalRemoved = (await bucket.file(canonicalOrphan).exists())[0] === false;
    staleRemoved = (await bucket.file(staleUpload).exists())[0] === false;
  }
  assert.equal(canonicalRemoved, true);
  assert.equal(staleRemoved, true);
  assert.equal((await bucket.file(readyCanonical).exists())[0], true);
  assert.notEqual((await db.doc('platformConfig/attachmentPurge').get()).data().objectPageToken, firstToken);
});

test('a seeded two-team household pilot keeps history when writers roll back', async () => {
  const event = await call('p220-admin', 'createEvent', {
    requestId: rid(), teamId: 'p220-a',
    event: {
      title: 'Synthetic pilot match', type: 'match', teamIds: ['p220-a', 'p220-b'],
      startsAt: '2026-12-20T23:00:00.000Z', endsAt: '2026-12-21T00:00:00.000Z', timeZone: 'America/Chicago',
      status: 'scheduled', publicationState: 'published',
    },
  });
  const raced = await Promise.allSettled([
    call('p220-parent1', 'respondToEvent', { requestId: rid(), eventId: event.id, participantId: 'p220-child-a', expectedRevision: 0, scheduleVersion: 1, status: 'yes' }),
    call('p220-parent2', 'respondToEvent', { requestId: rid(), eventId: event.id, participantId: 'p220-child-a', expectedRevision: 0, scheduleVersion: 1, status: 'maybe' }),
  ]);
  assert.equal(raced.filter((row) => row.status === 'fulfilled').length, 1);
  await call('p220-parent2', 'respondToEvent', { requestId: rid(), eventId: event.id, participantId: 'p220-child-b', expectedRevision: 0, scheduleVersion: 1, status: 'no' });
  assert.equal((await db.doc(`events/${event.id}/availability/p220-child-b`).get()).data().status, 'no');
  const viewer = await fail('p220-viewer', 'respondToEvent', { requestId: rid(), eventId: event.id, participantId: 'p220-child-a', expectedRevision: 0, scheduleVersion: 1, status: 'yes' });
  assert.equal(viewer.code, 'functions/permission-denied');
  const outsider = await fail('p220-outsider', 'getCanonicalEvent', { eventId: event.id });
  assert.equal(outsider.code, 'functions/permission-denied');
  const otherCoach = await fail('p220-other-coach', 'recordEventAttendance', {
    requestId: rid(), eventId: event.id, teamId: 'p220-a', participantId: 'p220-child-a', expectedRevision: 0, eventRevision: 1, scheduleVersion: 1, status: 'absent',
  });
  assert.equal(otherCoach.code, 'functions/permission-denied');
  await call('p220-coach', 'recordEventAttendance', {
    requestId: rid(), eventId: event.id, teamId: 'p220-a', participantId: 'p220-child-a', expectedRevision: 0, eventRevision: 1, scheduleVersion: 1, status: 'present',
  });
  assert.equal((await db.doc(`events/${event.id}/attendance/p220-child-a`).get()).data().status, 'present');
  const household = await call('p220-admin', 'postConversationMessage', { requestId: rid(), ...team, text: 'Practice is at the north field' });
  await call('p220-admin', 'postStaffNote', { requestId: rid(), ...team, text: 'Guardian phone is private' });
  const found = await call('p220-parent1', 'searchConversationMessages', { ...team, text: 'north' });
  assert.equal(found.items.some((item) => item.id === household.id), true);
  const hidden = await call('p220-parent1', 'searchConversationMessages', { ...team, text: 'phone' });
  assert.equal(hidden.items.some((item) => item.body?.includes('private')), false);
  assert.equal(JSON.stringify(hidden).includes('Guardian phone is private'), false);
  const self = await call('p220-self', 'getCanonicalEvent', { eventId: event.id });
  assert.equal(self.id, event.id);
  const now = Date.now();
  await db.doc(`organizations/${orgId}/scheduleOperations/stuck-pub`).set({
    schemaVersion: 2, orgId, draftId: 'p220-draft', operationId: 'stuck-pub', state: 'staging', revision: 1, fencingToken: 1,
    expected: [], stagingCursor: 0, promotionCursor: 0, actorUid: 'p220-admin',
    updatedAt: Timestamp.fromMillis(now - 11 * 60 * 1000), createdAt: Timestamp.fromMillis(now - 11 * 60 * 1000),
  });
  await db.doc(`organizations/${orgId}/scheduleOperations/fresh-pub`).set({
    schemaVersion: 2, orgId, draftId: 'p220-draft', operationId: 'fresh-pub', state: 'staging', revision: 1, fencingToken: 1,
    expected: [], updatedAt: Timestamp.fromMillis(now), createdAt: Timestamp.fromMillis(now), actorUid: 'p220-admin',
  });
  await db.doc(`organizations/${orgId}/scheduleOperations/done-pub`).set({
    schemaVersion: 2, orgId, state: 'committed', revision: 3, updatedAt: Timestamp.fromMillis(now - 30 * 60 * 1000), actorUid: 'p220-admin',
  });
  await db.doc(`organizations/${orgId}/scheduleDrafts/p220-draft`).set({
    schemaVersion: 2, orgId, state: 'privateDraft', divisionId: scope.divisionId, revision: 1, publicationOperationId: 'stuck-pub',
  });
  await db.doc(`organizations/${orgId}/schedulingLock/current`).set({
    schemaVersion: 2, orgId, operationId: 'stuck-pub', fencingToken: 1, inputRevision: 0, expiresAt: Timestamp.fromMillis(now + 120000),
  });
  await db.doc(`organizations/${orgId}/attachments/secret-file`).set({
    schemaVersion: 2, orgId, state: 'rejected', rejectionCode: 'SCAN_FAILED', ownerUid: 'p220-parent1', fileName: 'secret-photo.jpg', createdAt: Timestamp.now(),
  });
  const reports = await Promise.all(Array.from({ length: 8 }, () => call('p220-admin', 'listPilotOperations', { orgId })));
  for (const report of reports) assert.deepEqual(report, reports[0]);
  const report = reports[0];
  const body = JSON.stringify(report);
  assert.equal(body.includes('secret-photo.jpg'), false);
  assert.equal(body.includes('ownerUid'), false);
  assert.equal(body.includes('p220-parent1'), false);
  assert.equal(body.includes('p220-admin'), false);
  assert.equal(body.includes('@example.test'), false);
  assert.equal(report.flags.find((flag) => flag.name === 'attachments').enabled, true);
  assert.equal(report.flags.find((flag) => flag.name === 'organizationV2').enabled, true);
  assert.equal(report.youthChannels, 'approved');
  assert.equal(report.scanner.mode, 'content');
  assert.equal(report.scanner.externalConfigured, false);
  assert.equal(report.budgets.attachmentMaxBytes, 10 * 1024 * 1024);
  assert.equal(report.budgets.functionMemory, '512MiB');
  assert.ok(report.stuckOperations.some((row) => row.id === 'stuck-pub' && row.ageMinutes >= 10));
  assert.equal(report.stuckOperations.some((row) => row.id === 'fresh-pub' || row.id === 'done-pub'), false);
  assert.ok(report.rejections.some((row) => row.code === 'SCAN_FAILED' && row.count >= 1));
  assert.ok(report.attachments.rejected >= 1);
  assert.ok(report.attachments.ready >= 1);
  for (const uid of ['p220-staff', 'p220-revoked', 'p220-outsider', 'p220-foreign']) {
    const denied = await fail(uid, 'listPilotOperations', { orgId });
    assert.equal(denied.code, 'functions/permission-denied');
  }
  const unconfirmed = await fail('p220-admin', 'applyPilotRollback', { requestId: rid(), orgId, confirm: 'yes' });
  assert.equal(unconfirmed.code, 'functions/invalid-argument');
  const rollbackId = rid();
  const rollback = await call('p220-admin', 'applyPilotRollback', { requestId: rollbackId, orgId, confirm: PILOT_ROLLBACK_CONFIRM });
  assert.equal(rollback.truncated, false);
  assert.deepEqual(rollback.quarantinedOperationIds.sort(), ['fresh-pub', 'stuck-pub']);
  const replay = await call('p220-admin', 'applyPilotRollback', { requestId: rollbackId, orgId, confirm: PILOT_ROLLBACK_CONFIRM });
  assert.deepEqual(replay.quarantinedOperationIds.sort(), rollback.quarantinedOperationIds.sort());
  await db.doc(`organizations/${orgId}/members/p220-admin`).update({ status: 'revoked' });
  const revokedReplay = await fail('p220-admin', 'applyPilotRollback', { requestId: rollbackId, orgId, confirm: PILOT_ROLLBACK_CONFIRM });
  assert.equal(revokedReplay.code, 'functions/permission-denied');
  await db.doc(`organizations/${orgId}/members/p220-admin`).update({ status: 'active' });
  assert.equal((await db.doc(`organizations/${orgId}`).get()).data().features.attachments, false);
  assert.equal((await db.doc(`organizations/${orgId}`).get()).data().features.organizationV2, true);
  assert.equal((await db.doc(`organizations/${orgId}`).get()).data().features.households, true);
  assert.equal((await db.doc(`organizations/${orgId}/scheduleOperations/stuck-pub`).get()).data().state, 'quarantined');
  assert.equal((await db.doc(`organizations/${orgId}/scheduleOperations/done-pub`).get()).data().state, 'committed');
  assert.equal((await db.doc(`organizations/${orgId}/schedulingLock/current`).get()).data().operationId, 'stuck-pub');
  assert.equal((await db.doc(`events/${event.id}`).get()).exists, true);
  assert.equal((await db.doc(`events/${event.id}/attendance/p220-child-a`).get()).data().status, 'present');
  const quiet = await fail('p220-admin', 'postConversationMessage', { requestId: rid(), ...team, text: 'This write must stop' });
  assert.equal(quiet.details?.domainCode, 'FEATURE_DISABLED');
  await db.doc(`organizations/${orgId}`).update({ 'features.scheduler': true });
  const resumed = await fail('p220-admin', 'advanceSchedulePublication', {
    requestId: rid(), orgId, draftId: 'p220-draft', operationId: 'stuck-pub', expectedRevision: 2, fencingToken: 1, action: 'advance',
  });
  assert.equal(resumed.details?.domainCode, 'PUBLICATION_QUARANTINED');
  assert.equal((await db.doc(`events/${event.id}`).get()).data().title, 'Synthetic pilot match');
  await db.doc('teams/p220-a/roster/p220-child-a').update({ status: 'removed' });
  const removed = await fail('p220-self', 'getCanonicalEvent', { eventId: event.id });
  assert.equal(removed.code, 'functions/permission-denied');
  assert.equal(replay.flagsDisabled.join(','), PILOT_WRITER_FLAGS.join(','));
  const audits = await db.collection(`organizations/${orgId}/audit`).where('operation', '==', 'pilotRollback').get();
  assert.equal(audits.size, 1);
  assert.equal(JSON.stringify(audits.docs[0].data()).includes('secret-photo'), false);
});

test('rollback quarantines at most 20 in-flight publications and reports the remainder', async () => {
  const batch = db.batch();
  for (let index = 0; index < 21; index += 1) {
    const id = `roll-${String(index).padStart(2, '0')}`;
    batch.set(db.doc(`organizations/${orgId}/scheduleOperations/${id}`), {
      schemaVersion: 2, orgId, state: 'promoting', revision: 1, updatedAt: Timestamp.now(),
    });
  }
  await batch.commit();
  const rollback = await call('p220-admin', 'applyPilotRollback', { requestId: rid(), orgId, confirm: PILOT_ROLLBACK_CONFIRM });
  assert.equal(rollback.truncated, true);
  assert.equal(rollback.quarantinedOperationIds.length, 20);
  assert.equal((await db.doc(`organizations/${orgId}/scheduleOperations/roll-20`).get()).data().state, 'promoting');
  const retained = await db.collection('events').where('title', '==', 'Synthetic pilot match').get();
  assert.equal(retained.size, 1);
  assert.equal(retained.docs[0].data().publicationState, 'published');
});

test('a grant revoked during the sample receives no pilot report', async () => {
  const until = Date.now() + 2500;
  await db.doc('platformConfig/pilotListGate').set({ holdUntilMs: until });
  const pending = fail('p220-admin', 'listPilotOperations', { orgId });
  try {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await db.doc(`organizations/${orgId}/members/p220-admin`).update({ status: 'revoked' });
    const denied = await pending;
    assert.equal(denied.code, 'functions/permission-denied');
    assert.equal(JSON.stringify(denied).includes('SCAN_FAILED'), false);
    assert.equal(JSON.stringify(denied).includes('secret-photo'), false);
  } finally {
    await db.doc('platformConfig/pilotListGate').delete().catch(() => {});
    await db.doc(`organizations/${orgId}/members/p220-admin`).update({ status: 'active' });
  }
});

test('rollback keeps the locked publication on the page when its id sorts last', async () => {
  const batch = db.batch();
  for (let index = 0; index < 21; index += 1) {
    batch.set(db.doc(`organizations/${orgId}/scheduleOperations/page-${String(index).padStart(2, '0')}`), {
      schemaVersion: 2, orgId, draftId: 'p220-draft', state: 'promoting', revision: 1, fencingToken: 1, updatedAt: Timestamp.now(),
    });
  }
  batch.set(db.doc(`organizations/${orgId}/scheduleOperations/zzz-locked`), {
    schemaVersion: 2, orgId, draftId: 'p220-draft', operationId: 'zzz-locked', state: 'staging', revision: 1, fencingToken: 1,
    expected: [], updatedAt: Timestamp.now(), actorUid: 'p220-admin',
  });
  batch.set(db.doc(`organizations/${orgId}/schedulingLock/current`), {
    schemaVersion: 2, orgId, operationId: 'zzz-locked', fencingToken: 1, inputRevision: 0, expiresAt: Timestamp.fromMillis(Date.now() + 120000),
  });
  await batch.commit();
  const rollback = await call('p220-admin', 'applyPilotRollback', { requestId: rid(), orgId, confirm: PILOT_ROLLBACK_CONFIRM });
  assert.equal(rollback.truncated, true);
  assert.equal(rollback.quarantinedOperationIds.includes('zzz-locked'), true);
  assert.equal(rollback.quarantinedOperationIds.length, 20);
  assert.equal((await db.doc(`organizations/${orgId}/scheduleOperations/zzz-locked`).get()).data().state, 'quarantined');
  assert.equal((await db.doc(`organizations/${orgId}/schedulingLock/current`).get()).data().operationId, 'zzz-locked');
  await db.doc(`organizations/${orgId}`).update({ 'features.scheduler': true });
  await db.doc(`organizations/${orgId}/scheduleDrafts/p220-draft`).set({
    schemaVersion: 2, orgId, state: 'privateDraft', divisionId: scope.divisionId, revision: 1, publicationOperationId: 'zzz-locked',
  }, { merge: true });
  const resumed = await fail('p220-admin', 'advanceSchedulePublication', {
    requestId: rid(), orgId, draftId: 'p220-draft', operationId: 'zzz-locked', expectedRevision: 2, fencingToken: 1, action: 'advance',
  });
  assert.equal(resumed.details?.domainCode, 'PUBLICATION_QUARANTINED');
});

test('attachment samples stay at 100 rows and omit file names', async () => {
  const batch = db.batch();
  for (let index = 0; index < 101; index += 1) {
    batch.set(db.doc(`organizations/${orgId}/attachments/bulk-${String(index).padStart(3, '0')}`), {
      schemaVersion: 2, orgId, state: 'pending', ownerUid: 'hidden-bulk', fileName: `hidden-${index}.jpg`, createdAt: Timestamp.now(),
    });
  }
  await batch.commit();
  const report = await call('p220-admin', 'listPilotOperations', { orgId });
  assert.equal(report.attachments.pending, 100);
  assert.equal(report.attachments.truncated, true);
  const body = JSON.stringify(report);
  assert.equal(body.includes('hidden-bulk'), false);
  assert.equal(body.includes('.jpg'), false);
});

test('attachment functions keep a 10 MiB ceiling inside 512 MiB', () => {
  assert.equal(ATTACHMENT_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(PILOT_FUNCTION_MEMORY, '512MiB');
  assert.equal(attachmentTransport.__endpoint.availableMemoryMb, 512);
  assert.equal(attachmentTransport.__endpoint.timeoutSeconds, 60);
});
