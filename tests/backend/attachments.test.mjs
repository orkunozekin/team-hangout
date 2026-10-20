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
const { signUploadGrant, DEMO_ATTACHMENT_UPLOAD_KEY, contentScanner, sha256, ATTACHMENT_QUARANTINE_TTL_MS } = require('./lib/communications/attachmentScan.js');
const { purgeAbandonedAttachments } = require('./lib/communications/attachments.js');
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
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const pdf = Buffer.from('%PDF-1.4\n%SYNTHETIC-PDF-MARKER\n%%EOF');
const html = Buffer.from('<!DOCTYPE html><p>SYNTHETIC-HTML-MARKER</p>');
let admin, db, sequence = 0;
const apps = {};
const team = { orgId: 'file-org', scopeType: 'team', scopeId: 'file-team' };
const call = async (uid, name, data = {}) => (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const fail = async (uid, name, data = {}) => { try { await call(uid, name, data); assert.fail('expected rejection'); } catch (error) { return error; } };
const rid = () => `file-${++sequence}`;
const meta = { schemaVersion: 2, revision: 1, status: 'active', createdAt: Timestamp.now(), updatedAt: Timestamp.now() };
const transport = 'http://127.0.0.1:5001/demo-team-hangout/us-central1/attachmentTransport';

async function download(uid, attachmentId, scope = team) {
  const idToken = await getAuth(apps[uid]).currentUser.getIdToken();
  return fetch(transport, {
    headers: {
      Authorization: `Bearer ${idToken}`,
      'X-Org-Id': scope.orgId,
      'X-Scope-Type': scope.scopeType,
      'X-Scope-Id': scope.scopeId,
      'X-Attachment-Id': attachmentId,
    },
  });
}
async function putBytes(token, bytes, contentType = 'text/html') {
  return fetch(transport, { method: 'PUT', headers: { Authorization: `Attachment ${token}`, 'Content-Type': contentType }, body: bytes });
}

before(async () => {
  admin = adminApp({ projectId }, 'attachment-admin');
  db = getFirestore(admin);
  for (const uid of ['file-admin', 'file-staff', 'file-coach', 'file-guardian', 'file-self', 'file-outsider', 'file-poster']) {
    const app = initializeApp({ projectId, apiKey: 'demo-key' }, uid);
    apps[uid] = app;
    connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), '127.0.0.1', 5001);
    await adminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password: 'SyntheticPassword123!' });
    await db.doc(`users/${uid}`).set({ uid, email: `${uid}@example.test`, appRole: 'user' });
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, 'SyntheticPassword123!');
  }
  await db.doc('organizations/file-org').set({ ...meta, name: 'Synthetic Files', features: { organizationV2: true, households: true, conversations: true, attachments: true }, policies: {} });
  await db.doc('organizations/file-org/programs/file-program').set({ ...meta, orgId: 'file-org', name: 'Program' });
  await db.doc('organizations/file-org/members/file-admin').set({ ...meta, orgId: 'file-org', userId: 'file-admin', roles: ['orgAdmin'], programIds: [] });
  await db.doc('organizations/file-org/members/file-staff').set({ ...meta, orgId: 'file-org', userId: 'file-staff', roles: ['programStaff'], programIds: ['file-program'] });
  await db.doc('teams/file-team').set({ ...meta, orgId: 'file-org', programId: 'file-program', seasonId: 'file-season', divisionId: 'file-division', name: 'Falcons' });
  await db.doc('teamMembers/file-team_file-coach').set({ ...meta, orgId: 'file-org', teamId: 'file-team', userId: 'file-coach', roles: ['coach'] });
  await db.doc('teamMembers/file-team_file-poster').set({ ...meta, orgId: 'file-org', teamId: 'file-team', userId: 'file-poster', roles: ['coach'] });
  await db.doc('organizations/file-org/participants/file-child').set({ ...meta, orgId: 'file-org', displayName: 'Child', linkedUserId: 'file-self' });
  await db.doc('teams/file-team/roster/file-child').set({ ...meta, orgId: 'file-org', participantId: 'file-child' });
  await db.doc('organizations/file-org/participants/file-child/guardians/file-guardian').set({ ...meta, orgId: 'file-org', participantId: 'file-child', userId: 'file-guardian', permissions: { viewSchedule: true, respond: true } });
  await db.doc('events/file-staged').set({ ...meta, orgId: 'file-org', programId: 'file-program', teamId: 'file-team', teamIds: ['file-team'], title: 'Hidden', status: 'scheduled', publicationState: 'staged', publicationOperationId: 'file-op', deletedAt: null, timeZone: 'America/Chicago' });
});
after(async () => { await Promise.all(Object.values(apps).map((app) => deleteApp(app))); if (admin) await deleteAdmin(admin); });

test('the attachment flag stays off for an organization that only enabled conversations', async () => {
  const page = await call('file-guardian', 'listConversationMessages', { ...team, pageSize: 5 });
  assert.equal(page.attachments, 'enabled');
  assert.equal(page.canPost, false);
  await db.doc('organizations/file-org').update({ 'features.attachments': false });
  const disabled = await fail('file-staff', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'photo.jpg', declaredBytes: jpeg.length });
  assert.equal(disabled.details?.domainCode, 'FEATURE_DISABLED');
  const hidden = await call('file-staff', 'listConversationMessages', { ...team, pageSize: 5 });
  assert.equal(hidden.attachments, 'disabled');
  assert.equal(hidden.canPost, true);
  await db.doc('organizations/file-org').update({ 'features.attachments': true });
});

test('staff can transfer a JPEG while youth posting is closed, and a guardian can download it', async () => {
  const blocked = await fail('file-guardian', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'photo.jpg', declaredBytes: jpeg.length });
  assert.equal(blocked.details?.domainCode, 'YOUTH_POLICY');
  const direct = await fail('file-staff', 'createAttachmentUpload', { requestId: rid(), orgId: 'file-org', scopeType: 'direct', scopeId: 'file-coach', fileName: 'photo.jpg', declaredBytes: jpeg.length });
  assert.equal(direct.details?.domainCode, 'YOUTH_POLICY');
  const mime = await fail('file-staff', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'photo.jpg', declaredBytes: jpeg.length, contentType: 'text/html' });
  assert.equal(mime.code, 'functions/invalid-argument');
  const linked = await fail('file-staff', 'postConversationMessage', { requestId: rid(), ...team, text: 'Hello', attachmentIds: ['file'] });
  assert.equal(linked.details?.domainCode, 'ATTACHMENT_UNAVAILABLE');
  const grant = await call('file-staff', 'createAttachmentUpload', { requestId: 'jpeg-once', ...team, fileName: 'photo.jpg', declaredBytes: jpeg.length });
  const replay = await call('file-staff', 'createAttachmentUpload', { requestId: 'jpeg-once', ...team, fileName: 'photo.jpg', declaredBytes: jpeg.length });
  assert.equal(replay.id, grant.id);
  assert.equal(replay.token, grant.token);
  const reused = await fail('file-staff', 'createAttachmentUpload', { requestId: 'jpeg-once', ...team, fileName: 'photo.jpg', declaredBytes: jpeg.length + 1 });
  assert.equal(reused.details?.domainCode, 'REQUEST_ID_REUSED');
  const early = await download('file-guardian', grant.id);
  assert.equal(early.status, 404);
  const put = await putBytes(grant.token, jpeg);
  assert.equal(put.status, 200);
  const quarantined = await download('file-staff', grant.id);
  assert.equal(quarantined.status, 404);
  const row = (await db.doc(`organizations/file-org/attachments/${grant.id}`).get()).data();
  assert.equal(row.state, 'quarantined');
  assert.equal(row.messageId, null);
  assert.equal(JSON.stringify(row).includes('SYNTHETIC-JPEG-MARKER'), false);
  const open = await fetch(`http://127.0.0.1:9199/v0/b/demo-team-hangout.appspot.com/o/${encodeURIComponent(row.objectPath)}?alt=media`);
  assert.notEqual(open.status, 200);
  const objectBytes = await getStorage(admin).bucket(`${projectId}.appspot.com`).file(row.objectPath).download();
  assert.equal(Buffer.compare(objectBytes[0], jpeg), 0);
  const done = await call('file-staff', 'finalizeAttachment', { requestId: rid(), ...team, attachmentId: grant.id });
  assert.equal(done.state, 'ready');
  assert.equal(done.detectedType, 'image/jpeg');
  assert.equal(done.scan.scanner, 'content');
  assert.equal(done.scan.verdict, 'clean');
  assert.equal(done.sha256, sha256(cleanedJpeg));
  assert.notEqual(done.sha256, sha256(jpeg));
  const saved = await download('file-guardian', grant.id);
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get('content-type'), 'image/jpeg');
  const savedBytes = Buffer.from(await saved.arrayBuffer());
  assert.equal(Buffer.compare(savedBytes, cleanedJpeg), 0);
  assert.equal(savedBytes.includes(Buffer.from('GPS-SYNTHETIC')), false);
  assert.equal(saved.headers.get('cache-control'), 'private, no-store');
  const outsider = await download('file-outsider', grant.id);
  assert.equal(outsider.status, 404);
  await call('file-staff', 'postStaffNote', { requestId: rid(), ...team, text: 'Guardian phone is private' });
  await call('file-coach', 'postConversationMessage', { requestId: rid(), ...team, text: 'Practice is at the north field' });
  const channel = await call('file-guardian', 'listConversationMessages', { ...team, pageSize: 25 });
  const notes = await call('file-admin', 'listStaffNotes', { ...team, pageSize: 10 });
  const stored = JSON.stringify({
    channel,
    notes,
    messages: (await db.collection(`organizations/file-org/conversations/${channel.conversationId}/messages`).get()).docs.map((doc) => doc.data()),
    search: (await db.collection('organizations/file-org/messageSearch').get()).docs.map((doc) => doc.data()),
    notifications: (await db.collection('users/file-guardian/notifications').get()).docs.map((doc) => doc.data()),
    outbox: (await db.collection('organizations/file-org/outbox').get()).docs.map((doc) => doc.data()),
  });
  assert.equal(stored.includes('GPS-SYNTHETIC'), false);
  assert.equal(stored.includes(jpeg.toString('base64')), false);
  assert.equal(stored.includes(cleanedJpeg.toString('base64')), false);
});

test('PNG and PDF transfers round-trip and a lied JPEG signature is rejected', async () => {
  for (const [name, bytes, type] of [['diagram.png', png, 'image/png'], ['form.pdf', pdf, 'application/pdf']]) {
    const grant = await call('file-coach', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: name, declaredBytes: bytes.length });
    assert.equal((await putBytes(grant.token, bytes, 'application/octet-stream')).status, 200);
    const done = await call('file-coach', 'finalizeAttachment', { requestId: rid(), ...team, attachmentId: grant.id });
    assert.equal(done.detectedType, type);
    const saved = await download('file-self', grant.id);
    assert.equal(saved.headers.get('content-type'), type);
    assert.equal(Buffer.compare(Buffer.from(await saved.arrayBuffer()), bytes), 0);
  }
  const grant = await call('file-staff', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'photo.jpg', declaredBytes: html.length });
  assert.equal((await putBytes(grant.token, html)).status, 200);
  const requestId = rid();
  const rejected = await call('file-staff', 'finalizeAttachment', { requestId, ...team, attachmentId: grant.id });
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.rejectionCode, 'UNSAFE_CONTENT');
  assert.equal((await download('file-staff', grant.id)).status, 404);
  const row = (await db.doc(`organizations/file-org/attachments/${grant.id}`).get()).data();
  assert.equal(row.state, 'rejected');
  const storedFile = getStorage(admin).bucket(`${projectId}.appspot.com`).file(row.objectPath);
  assert.equal((await storedFile.exists())[0], false);
  await storedFile.save(html);
  const replay = await call('file-staff', 'finalizeAttachment', { requestId, ...team, attachmentId: grant.id });
  assert.equal(replay.state, 'rejected');
  assert.equal(replay.rejectionCode, 'UNSAFE_CONTENT');
  assert.equal((await storedFile.exists())[0], false);
});

test('preflight allows the deployed admin origins and emulator loopback, and a missing object is an integrity failure', async () => {
  const evil = await fetch(transport, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'PUT' } });
  assert.equal(evil.status, 204);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
  const local = await fetch(transport, { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:4177', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(local.headers.get('access-control-allow-origin'), 'http://127.0.0.1:4177');
  assert.equal(local.headers.get('access-control-allow-credentials'), null);
  const staging = await fetch(transport, { method: 'OPTIONS', headers: { Origin: 'https://team-hangout-staging.web.app', 'Access-Control-Request-Method': 'PUT' } });
  assert.equal(staging.headers.get('access-control-allow-origin'), 'https://team-hangout-staging.web.app');
  const production = await fetch(transport, { method: 'OPTIONS', headers: { Origin: 'https://team-hangout-ddf27.firebaseapp.com', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(production.headers.get('access-control-allow-origin'), 'https://team-hangout-ddf27.firebaseapp.com');
  const grant = await call('file-staff', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'photo.jpg', declaredBytes: jpeg.length });
  assert.equal((await putBytes(grant.token, jpeg)).status, 200);
  const row = (await db.doc(`organizations/file-org/attachments/${grant.id}`).get()).data();
  await getStorage(admin).bucket(`${projectId}.appspot.com`).file(row.objectPath).delete();
  const missing = await call('file-staff', 'finalizeAttachment', { requestId: rid(), ...team, attachmentId: grant.id });
  assert.equal(missing.state, 'rejected');
  assert.equal(missing.rejectionCode, 'INTEGRITY');
  assert.equal((await db.doc(`organizations/file-org/attachments/${grant.id}`).get()).data().state, 'rejected');
});

test('oversized and expired uploads are rejected before they can be downloaded', async () => {
  const oversized = await fail('file-staff', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'big.jpg', declaredBytes: 10 * 1024 * 1024 + 1 });
  assert.equal(oversized.details?.domainCode, 'OVERSIZED');
  const grant = await call('file-staff', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'photo.jpg', declaredBytes: jpeg.length });
  const mismatch = await putBytes(grant.token, Buffer.concat([jpeg, Buffer.from([0])]));
  assert.equal(mismatch.status, 413);
  assert.equal(await mismatch.text(), 'This file does not match the reserved upload.');
  assert.equal((await db.doc(`organizations/file-org/attachments/${grant.id}`).get()).data().state, 'rejected');
  assert.equal((await download('file-staff', grant.id)).status, 404);
  const expiring = await call('file-staff', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'photo.jpg', declaredBytes: jpeg.length });
  await db.doc(`organizations/file-org/attachments/${expiring.id}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
  const late = await putBytes(expiring.token, jpeg);
  assert.equal(late.status, 410);
  assert.equal((await db.doc(`organizations/file-org/attachments/${expiring.id}`).get()).data().rejectionCode, 'EXPIRED');
  const fresh = await call('file-staff', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'photo.jpg', declaredBytes: jpeg.length });
  const forged = signUploadGrant({
    v: 1, exp: 10, attachmentId: fresh.id, uid: 'file-staff', orgId: 'file-org', bytes: jpeg.length, path: `quarantine/file-org/${fresh.id}/1`,
  }, DEMO_ATTACHMENT_UPLOAD_KEY);
  assert.equal((await putBytes(forged, jpeg)).status, 410);
  const pending = await call('file-admin', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'photo.jpg', declaredBytes: jpeg.length });
  assert.equal((await putBytes(pending.token, jpeg)).status, 200);
  await db.doc(`organizations/file-org/attachments/${pending.id}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
  const finished = await call('file-admin', 'finalizeAttachment', { requestId: rid(), ...team, attachmentId: pending.id });
  assert.equal(finished.rejectionCode, 'EXPIRED');
  assert.equal((await download('file-admin', pending.id)).status, 404);
});

test('a fourth reservation is refused until an expired one is released, and revoked readers lose the file', async () => {
  await db.doc('organizations/file-org').update({ 'policies.youthChannels': 'approved' });
  const ids = [];
  for (let index = 0; index < 3; index += 1) {
    const grant = await call('file-guardian', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'photo.jpg', declaredBytes: jpeg.length });
    ids.push(grant.id);
  }
  const limited = await fail('file-guardian', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'photo.jpg', declaredBytes: jpeg.length });
  assert.equal(limited.details?.domainCode, 'ATTACHMENT_LIMIT');
  await db.doc(`organizations/file-org/attachments/${ids[0]}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
  const released = await call('file-guardian', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'photo.jpg', declaredBytes: jpeg.length });
  assert.ok(released.id);
  const grant = await call('file-staff', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'photo.jpg', declaredBytes: jpeg.length });
  assert.equal((await putBytes(grant.token, jpeg)).status, 200);
  const ready = await call('file-staff', 'finalizeAttachment', { requestId: rid(), ...team, attachmentId: grant.id });
  assert.equal(ready.state, 'ready');
  await db.doc('organizations/file-org/participants/file-child/guardians/file-guardian').update({ status: 'revoked' });
  assert.equal((await download('file-guardian', grant.id)).status, 404);
  assert.equal((await download('file-staff', grant.id)).status, 200);
  const hiddenEvent = await fail('file-self', 'createAttachmentUpload', { requestId: rid(), orgId: 'file-org', scopeType: 'event', scopeId: 'file-staged', fileName: 'photo.jpg', declaredBytes: jpeg.length });
  assert.equal(hiddenEvent.code, 'functions/permission-denied');
  const staffEvent = await call('file-staff', 'createAttachmentUpload', { requestId: rid(), orgId: 'file-org', scopeType: 'event', scopeId: 'file-staged', fileName: 'photo.jpg', declaredBytes: jpeg.length });
  assert.equal(staffEvent.state, 'pending');
  await db.doc('organizations/file-org/participants/file-child/guardians/file-guardian').update({ status: 'active' });
  await db.doc('organizations/file-org').update({ 'policies.youthChannels': 'approved' });
});

test('unauthorized download, revoked membership, wrong signature, scanner failure, and orphan cleanup', async () => {
  const anonymous = await fetch(transport, { headers: { 'X-Org-Id': 'file-org', 'X-Scope-Type': 'team', 'X-Scope-Id': 'file-team', 'X-Attachment-Id': 'missing-file' } });
  assert.equal(anonymous.status, 401);
  const mismatched = await call('file-poster', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'notes.pdf', declaredBytes: jpeg.length });
  assert.equal((await putBytes(mismatched.token, jpeg)).status, 200);
  const wrong = await call('file-poster', 'finalizeAttachment', { requestId: rid(), ...team, attachmentId: mismatched.id });
  assert.equal(wrong.rejectionCode, 'SIGNATURE_MISMATCH');
  assert.notEqual(wrong.scan.scanner, 'content');
  const active = Buffer.from('%PDF-1.4\n1 0 obj\n<< /JavaScript (alert) >>\nendobj\n%%EOF');
  const scriptGrant = await call('file-poster', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'form.pdf', declaredBytes: active.length });
  assert.equal((await putBytes(scriptGrant.token, active, 'application/pdf')).status, 200);
  const script = await call('file-poster', 'finalizeAttachment', { requestId: rid(), ...team, attachmentId: scriptGrant.id });
  assert.equal(script.state, 'rejected');
  assert.equal(script.rejectionCode, 'ACTIVE_CONTENT');
  assert.equal(script.scan.scanner, 'content');
  assert.notEqual(script.rejectionCode, 'INTEGRITY');
  assert.notEqual(script.rejectionCode, 'ACCESS_REVOKED');
  const ids = [];
  const hold = await call('file-poster', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'one.jpg', declaredBytes: jpeg.length });
  assert.equal((await putBytes(hold.token, jpeg)).status, 200);
  const earlyLink = await fail('file-poster', 'postConversationMessage', { requestId: rid(), ...team, text: 'Not ready', attachmentIds: [hold.id] });
  assert.equal(earlyLink.details?.domainCode, 'ATTACHMENT_UNAVAILABLE');
  const first = await call('file-poster', 'finalizeAttachment', { requestId: rid(), ...team, attachmentId: hold.id });
  assert.equal(first.state, 'ready');
  ids.push(hold.id);
  for (const name of ['two.jpg', 'three.jpg']) {
    const grant = await call('file-poster', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: name, declaredBytes: jpeg.length });
    assert.equal((await putBytes(grant.token, jpeg)).status, 200);
    const done = await call('file-poster', 'finalizeAttachment', { requestId: rid(), ...team, attachmentId: grant.id });
    assert.equal(done.state, 'ready');
    assert.equal(done.byteLength, cleanedJpeg.length);
    ids.push(grant.id);
  }
  const capped = await fail('file-poster', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'four.jpg', declaredBytes: jpeg.length });
  assert.equal(capped.details?.domainCode, 'ATTACHMENT_LIMIT');
  const tooMany = await fail('file-poster', 'postConversationMessage', { requestId: rid(), ...team, text: 'Too many files', attachmentIds: [...ids, 'extra-attachment-id'] });
  assert.equal(tooMany.details?.domainCode, 'ATTACHMENT_LIMIT');
  const stolen = await fail('file-coach', 'postConversationMessage', { requestId: rid(), ...team, text: 'Not mine', attachmentIds: [ids[0]] });
  assert.equal(stolen.details?.domainCode, 'ATTACHMENT_UNAVAILABLE');
  const note = await fail('file-poster', 'postStaffNote', { requestId: rid(), ...team, text: 'Hidden', attachmentIds: [ids[0]] });
  assert.equal(note.code, 'functions/invalid-argument');
  const posted = await call('file-poster', 'postConversationMessage', { requestId: rid(), ...team, text: 'Practice photo is attached', attachmentIds: ids });
  const page = await call('file-guardian', 'listConversationMessages', { ...team, pageSize: 25 });
  const message = page.items.find((item) => item.id === posted.id);
  assert.equal(message.body, 'Practice photo is attached');
  assert.deepEqual(message.attachments.map((item) => item.fileName), ['one.jpg', 'two.jpg', 'three.jpg']);
  assert.equal(JSON.stringify(message).includes('GPS-SYNTHETIC'), false);
  const search = await call('file-guardian', 'searchConversationMessages', { ...team, text: 'photo' });
  assert.equal(search.items.some((item) => item.id === posted.id), true);
  const byName = await call('file-guardian', 'searchConversationMessages', { ...team, text: 'one' });
  assert.equal(byName.items.some((item) => item.id === posted.id), false);
  const linked = await download('file-guardian', ids[0]);
  assert.equal(linked.status, 200);
  assert.equal(Buffer.compare(Buffer.from(await linked.arrayBuffer()), cleanedJpeg), 0);
  assert.equal((await download('file-outsider', ids[0])).status, 404);
  const released = await call('file-poster', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'four.jpg', declaredBytes: jpeg.length });
  assert.equal(released.state, 'pending');
  await db.doc('organizations/file-org/participants/file-child/guardians/file-guardian').update({ status: 'revoked' });
  assert.equal((await download('file-guardian', ids[0])).status, 404);
  assert.equal((await download('file-poster', ids[0])).status, 200);
  await db.doc('organizations/file-org/participants/file-child/guardians/file-guardian').update({ status: 'active' });
  await call('file-admin', 'moderateConversationMessage', { requestId: rid(), ...team, messageId: posted.id, reason: 'Remove the photo' });
  assert.equal((await download('file-poster', ids[0])).status, 404);
  const bucket = getStorage(admin).bucket(`${projectId}.appspot.com`);
  const row = (await db.doc(`organizations/file-org/attachments/${ids[0]}`).get()).data();
  const abandonedId = 'abandoned-quarantine';
  const abandonedPath = `quarantine/file-org/${abandonedId}/1`;
  await bucket.file(abandonedPath).save(jpeg, { resumable: false });
  await db.doc(`organizations/file-org/attachments/${abandonedId}`).set({
    schemaVersion: 2, orgId: 'file-org', conversationId: row.conversationId, ownerUid: 'file-poster', state: 'quarantined',
    objectPath: abandonedPath, createdAt: Timestamp.fromMillis(Date.now() - ATTACHMENT_QUARANTINE_TTL_MS - 5000), updatedAt: Timestamp.now(),
  });
  const slots = await db.collection('organizations/file-org/attachmentSlots').where('ownerUid', '==', 'file-poster').get();
  assert.equal(slots.size, 1);
  await slots.docs[0].ref.set({ activeIds: [abandonedId, 'missing-slot-id', ids[1]] }, { merge: true });
  const orphanPath = 'quarantine/file-org/orphan-old/1';
  const freshPath = 'quarantine/file-org/orphan-fresh/1';
  await bucket.file(orphanPath).save(Buffer.from('orphan-bytes'));
  await bucket.file(freshPath).save(Buffer.from('fresh-bytes'));
  await db.doc(`organizations/file-org/attachments/${scriptGrant.id}`).update({ createdAt: Timestamp.fromMillis(Date.now() - ATTACHMENT_QUARANTINE_TTL_MS - 5000) });
  await purgeAbandonedAttachments(Date.now(), {
    db, bucket, objectTimeMs: (name, created) => name === orphanPath ? Date.now() - ATTACHMENT_QUARANTINE_TTL_MS - 1000 : created,
  });
  assert.equal((await db.doc(`organizations/file-org/attachments/${abandonedId}`).get()).exists, false);
  assert.equal((await bucket.file(abandonedPath).exists())[0], false);
  assert.equal((await bucket.file(orphanPath).exists())[0], false);
  assert.equal((await bucket.file(freshPath).exists())[0], true);
  assert.equal((await db.doc(`organizations/file-org/attachments/${ids[1]}`).get()).exists, true);
  assert.equal((await bucket.file(row.objectPath).exists())[0], true);
  assert.equal((await db.doc(`organizations/file-org/attachments/${scriptGrant.id}`).get()).exists, false);
  const slot = (await slots.docs[0].ref.get()).data();
  assert.deepEqual(slot.activeIds, [ids[1]]);
  const config = db.doc('platformConfig/attachmentScanner');
  try {
    await config.set({ mode: 'unavailable' });
    const grant = await call('file-poster', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'five.jpg', declaredBytes: jpeg.length });
    assert.equal((await putBytes(grant.token, jpeg)).status, 200);
    const failed = await call('file-poster', 'finalizeAttachment', { requestId: rid(), ...team, attachmentId: grant.id });
    assert.equal(failed.state, 'rejected');
    assert.equal(failed.rejectionCode, 'SCAN_FAILED');
    assert.notEqual(failed.rejectionCode, 'INTEGRITY');
    assert.notEqual(failed.rejectionCode, 'ACCESS_REVOKED');
    assert.equal((await bucket.file(`quarantine/file-org/${grant.id}/1`).exists())[0], false);
  } finally {
    await config.delete();
  }
});

test('canonicalizing rejects the original upload and finalizes the stripped length', async () => {
  const grant = await call('file-poster', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'retry.jpg', declaredBytes: jpeg.length });
  assert.equal((await putBytes(grant.token, jpeg)).status, 200);
  const bucket = getStorage(admin).bucket(`${projectId}.appspot.com`);
  const canonicalPath = `quarantine/file-org/${grant.id}/2`;
  await bucket.file(canonicalPath).save(cleanedJpeg, { resumable: false });
  await db.doc(`organizations/file-org/attachments/${grant.id}`).update({
    state: 'canonicalizing', canonicalSha256: sha256(cleanedJpeg), canonicalBytes: cleanedJpeg.length,
  });
  assert.equal((await putBytes(grant.token, jpeg)).status, 409);
  const done = await call('file-poster', 'finalizeAttachment', { requestId: rid(), ...team, attachmentId: grant.id });
  assert.equal(done.state, 'ready');
  assert.equal(done.byteLength, cleanedJpeg.length);
  assert.equal(done.sha256, sha256(cleanedJpeg));
  const downloaded = await download('file-poster', grant.id);
  assert.equal(downloaded.status, 200);
  assert.equal(Buffer.compare(Buffer.from(await downloaded.arrayBuffer()), cleanedJpeg), 0);
  const row = (await db.doc(`organizations/file-org/attachments/${grant.id}`).get()).data();
  assert.equal(row.objectPath, canonicalPath);
});

test('orphan cleanup continues past the first storage page', async () => {
  const bucket = getStorage(admin).bucket(`${projectId}.appspot.com`);
  const pads = [];
  for (let index = 0; index < 2; index += 1) {
    const name = `quarantine/000/p${index}/1`;
    pads.push(name);
    await bucket.file(name).save(Buffer.from(`pad-${index}`));
  }
  const orphan = 'quarantine/zzz/late-orphan/1';
  await bucket.file(orphan).save(Buffer.from('late-orphan'));
  const clock = (name, created) => name === orphan ? Date.now() - ATTACHMENT_QUARANTINE_TTL_MS - 1000 : Date.now();
  const options = { db, bucket, objectPages: 1, objectPageSize: 1, objectTimeMs: clock };
  await purgeAbandonedAttachments(Date.now(), options);
  assert.equal((await bucket.file(orphan).exists())[0], true);
  const firstToken = (await db.doc('platformConfig/attachmentPurge').get()).data().objectPageToken;
  assert.equal(typeof firstToken, 'string');
  let removed = false;
  for (let attempt = 0; attempt < 40 && !removed; attempt += 1) {
    await purgeAbandonedAttachments(Date.now(), options);
    removed = (await bucket.file(orphan).exists())[0] === false;
  }
  assert.equal(removed, true);
  const laterToken = (await db.doc('platformConfig/attachmentPurge').get()).data().objectPageToken;
  assert.notEqual(laterToken, firstToken);
  const canonicalOrphan = 'quarantine/zzz/late-canonical/2';
  const readyCanonical = 'quarantine/zzz/kept-canonical/2';
  const staleUpload = 'quarantine/zzz/kept-canonical/1';
  await bucket.file(canonicalOrphan).save(Buffer.from('late-canonical'));
  await bucket.file(readyCanonical).save(Buffer.from('kept-canonical'));
  await bucket.file(staleUpload).save(Buffer.from('stale-upload'));
  await db.doc('organizations/zzz/attachments/kept-canonical').set({
    state: 'ready', objectPath: readyCanonical, createdAt: Timestamp.fromMillis(Date.now() - ATTACHMENT_QUARANTINE_TTL_MS - 5000),
  });
  await db.doc('platformConfig/attachmentPurge').set({ objectPageToken: null }, { merge: true });
  const aged = new Set([canonicalOrphan, readyCanonical, staleUpload]);
  const agedClock = (name, created) => aged.has(name) ? Date.now() - ATTACHMENT_QUARANTINE_TTL_MS - 1000 : Date.now();
  const paged = { db, bucket, objectPages: 1, objectPageSize: 1, objectTimeMs: agedClock };
  let canonicalRemoved = false;
  let staleRemoved = false;
  for (let attempt = 0; attempt < 60 && (!canonicalRemoved || !staleRemoved); attempt += 1) {
    await purgeAbandonedAttachments(Date.now(), paged);
    canonicalRemoved = (await bucket.file(canonicalOrphan).exists())[0] === false;
    staleRemoved = (await bucket.file(staleUpload).exists())[0] === false;
  }
  assert.equal(canonicalRemoved, true);
  assert.equal(staleRemoved, true);
  assert.equal((await bucket.file(readyCanonical).exists())[0], true);
  for (const name of pads) assert.equal((await bucket.file(name).exists())[0], true);
});

test('an expired grant finalizes a fenced canonical object and still rejects a missing one', async () => {
  const missing = await call('file-poster', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'expired.jpg', declaredBytes: jpeg.length });
  assert.equal((await putBytes(missing.token, jpeg)).status, 200);
  await db.doc(`organizations/file-org/attachments/${missing.id}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
  const expired = await call('file-poster', 'finalizeAttachment', { requestId: rid(), ...team, attachmentId: missing.id });
  assert.equal(expired.state, 'rejected');
  assert.equal(expired.rejectionCode, 'EXPIRED');
  const grant = await call('file-poster', 'createAttachmentUpload', { requestId: rid(), ...team, fileName: 'late.jpg', declaredBytes: jpeg.length });
  assert.equal((await putBytes(grant.token, jpeg)).status, 200);
  const bucket = getStorage(admin).bucket(`${projectId}.appspot.com`);
  const canonicalPath = `quarantine/file-org/${grant.id}/2`;
  await bucket.file(canonicalPath).save(cleanedJpeg, { resumable: false });
  await db.doc(`organizations/file-org/attachments/${grant.id}`).update({
    state: 'canonicalizing', canonicalSha256: sha256(cleanedJpeg), canonicalBytes: cleanedJpeg.length, expiresAt: Timestamp.fromMillis(Date.now() - 1000),
  });
  const done = await call('file-poster', 'finalizeAttachment', { requestId: rid(), ...team, attachmentId: grant.id });
  assert.equal(done.state, 'ready');
  assert.equal(done.rejectionCode, null);
  assert.equal(done.byteLength, cleanedJpeg.length);
  assert.equal(done.sha256, sha256(cleanedJpeg));
  const downloaded = await download('file-poster', grant.id);
  assert.equal(downloaded.status, 200);
  assert.equal(Buffer.compare(Buffer.from(await downloaded.arrayBuffer()), cleanedJpeg), 0);
});
