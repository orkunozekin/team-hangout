import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDoc, updateDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { projectId, requireEmulators } from './fixtures.mjs';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp: initAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth: adminAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');
requireEmulators();
let admin, db, auth, env, beginDeletion, resumeDeletion;
const clients = [];
before(async () => {
  admin = initAdmin({ projectId, storageBucket: `${projectId}.appspot.com` }); db = getFirestore(); auth = adminAuth();
  ({ beginDeletion, resumeDeletion } = require('./lib/accounts/deletion.js'));
  env = await initializeTestEnvironment({ projectId, firestore: { host: '127.0.0.1', port: 8080, rules: readFileSync('firestore.rules', 'utf8') } });
});
after(async () => { await env?.cleanup(); await Promise.all(clients.map(deleteApp)); await deleteAdmin(admin); });
async function actor(uid) {
  await auth.createUser({ uid, email: `${uid}@example.test`, password: 'SyntheticPassword123!' });
  await db.doc(`users/${uid}`).set({ uid, displayName: uid, appRole: 'user' });
  const app = initializeApp({ projectId, apiKey: 'demo-key' }, uid); clients.push(app);
  connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });
  await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, 'SyntheticPassword123!');
  const functions = getFunctions(app); connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  return (name, data = {}) => httpsCallable(functions, name)(data);
}
async function finish(uid) {
  for (let i = 0; i < 100; i++) {
    const state = await resumeDeletion(uid, 10);
    if (state?.status === 'complete') return state;
    assert.equal(state.lastError, null, JSON.stringify(state));
  }
  assert.fail('Worker did not finish');
}
test('deny-first blocks cached-token callables and all legacy rules before cleanup, even after profile recreation', async () => {
  const uid = 'erase-access'; const call = await actor(uid);
  await db.doc(`teamMembers/erase-team_${uid}`).set({ userId: uid, teamId: 'erase-team', role: 'coach' });
  await db.doc('teams/erase-team').set({ name: 'Retained team' });
  await db.doc('events/erase-event').set({ teamId: 'erase-team', deletedAt: null });
  const initial = await beginDeletion(uid); assert.equal(initial.status, 'pending');
  assert.equal((await db.doc(`teamMembers/erase-team_${uid}`).get()).exists, true);
  for (const name of ['listMyParticipants', 'listMyOrganizations', 'listLegacyTeams', 'createTeam']) {
    const data = name === 'createTeam' ? { requestId: 'erased-request', name: 'Denied' } : {};
    await assert.rejects(call(name, data), { code: 'functions/permission-denied' });
  }
  const client = env.authenticatedContext(uid, { email: `${uid}@example.test` }).firestore();
  for (const path of [`users/${uid}`, `teamMembers/erase-team_${uid}`, 'teams/erase-team', 'events/erase-event', `accountDeletionJobs/${uid}`]) await assertFails(getDoc(doc(client, path)));
  await assertFails(updateDoc(doc(client, `users/${uid}`), { displayName: 'Restore', updatedAt: serverTimestamp() }));
  await finish(uid);
  await assertFails(setDoc(doc(client, `users/${uid}`), { uid, appRole: 'user', displayName: 'Restored', email: `${uid}@example.test`, activeTeamId: null, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
  // Even an accidental trusted profile recreation cannot revive the identity.
  await db.doc(`users/${uid}`).set({ uid, accountState: 'active' });
  await assert.rejects(call('listMyParticipants'), { code: 'functions/permission-denied' });
  await db.doc(`users/${uid}`).delete();
});
test('paged deletion survives interruption and concurrent workers beyond a batch without touching history', async () => {
  const uid = 'erase-paged'; const call = await actor(uid);
  for (let start = 0; start < 520; start += 200) {
    const batch = db.batch();
    for (let i = start; i < Math.min(start + 200, 520); i++) batch.set(db.doc(`teamMembers/erase-paged-${String(i).padStart(4, '0')}`), { userId: uid, teamId: `old-${i}` });
    await batch.commit();
  }
  await db.doc('teams/erase-history').set({ createdBy: uid, name: 'History' });
  await db.doc('events/erase-history').set({ createdBy: uid, teamId: 'erase-history' });
  await db.doc('teamMembers/erase-survivor').set({ userId: 'retained', teamId: 'erase-history' });
  await beginDeletion(uid);
  let state = await resumeDeletion(uid, 1); assert.equal(state.membershipsRemoved, 25); assert.equal(state.status, 'pending');
  const accepted = (await call('deleteAccount')).data;
  assert.equal(accepted.ok, true); assert.equal(accepted.jobStatus, 'pending');
  assert.ok(accepted.membershipsRemoved > 25);
  await Promise.all([resumeDeletion(uid, 2), resumeDeletion(uid, 2)]);
  state = await finish(uid); assert.equal(state.membershipsRemoved, 520);
  assert.ok(state.pages > 20); assert.ok(state.attempts > 1); assert.ok(state.completedAt);
  assert.equal((await db.collection('teamMembers').where('userId', '==', uid).get()).size, 0);
  for (const path of ['teams/erase-history', 'events/erase-history', 'teamMembers/erase-survivor']) assert.equal((await db.doc(path).get()).exists, true);
  assert.deepEqual(await resumeDeletion(uid, 1), state);
});
test('last admin and only guardian can delete; children, other guardians, roster and live administration survive', async () => {
  const uid = 'erase-household'; await actor(uid); await actor('erase-retained');
  for (const orgId of ['erase-only-org', 'erase-shared-org']) {
    await db.doc(`organizations/${orgId}`).set({ schemaVersion: 2, revision: 1, status: 'active', features: { households: true } });
    // Legacy Step 3 canonical members intentionally lack userId.
    await db.doc(`organizations/${orgId}/members/${uid}`).set({ orgId, roles: ['orgAdmin'], status: 'active' });
  }
  await db.doc('organizations/erase-shared-org/members/erase-retained').set({ orgId: 'erase-shared-org', roles: ['orgAdmin'], status: 'active' });
  const root = 'organizations/erase-only-org/participants';
  for (const id of ['only', 'shared', 'self']) await db.doc(`${root}/${id}`).set({ schemaVersion: 2, displayName: 'Retained participant', status: 'active', revision: 1, accessRevision: 1, linkedUserId: id === 'self' ? uid : null });
  for (const id of ['only', 'shared']) await db.doc(`${root}/${id}/guardians/${uid}`).set({ orgId: 'erase-only-org', participantId: id, userId: uid, status: 'active', permissions: { viewProfile: true } });
  const survivor = { orgId: 'erase-only-org', participantId: 'shared', userId: 'erase-retained', status: 'active', permissions: { viewProfile: true } };
  await db.doc(`${root}/shared/guardians/erase-retained`).set(survivor);
  await db.doc(`${root}/self/private/profile`).set({ contactEmail: 'owned@example.test', contactPhone: '555-0100', operationalNotes: 'Organization history', birthDate: '1990-01-01' });
  await db.doc('teams/erase-roster/roster/shared').set({ participantId: 'shared', status: 'active' });
  for (const projection of ['participantLinks', 'organizationLinks', 'teamAccess', 'agenda', 'notifications', 'deviceTokens', 'notificationEndpoints']) await db.doc(`users/${uid}/${projection}/pointer`).set({ private: 'Remove' });
  const { cleanupHooks } = require('./lib/accounts/deletion.js');
  for (const [collection, field] of cleanupHooks) {
    await db.doc(`${collection}/erase-owned`).set({ [field]: uid, token: 'synthetic-token' });
    await db.doc(`${collection}/erase-other`).set({ [field]: 'erase-retained' });
  }
  await db.doc(`organizationOwners/${uid}`).set({ enabled: true });
  await beginDeletion(uid); await finish(uid);
  assert.equal((await db.doc('organizations/erase-only-org').get()).data().administrativeControl, 'recoveryRequired');
  const recoveryAudit = await db.collection('organizations/erase-only-org/audit').get();
  assert.equal(recoveryAudit.size, 1);
  assert.equal(recoveryAudit.docs[0].id.includes(uid), false);
  assert.deepEqual(Object.keys(recoveryAudit.docs[0].data()).sort(), ['createdAt', 'operation', 'schemaVersion']);
  assert.equal((await db.doc('organizations/erase-shared-org').get()).data().administrativeControl, undefined);
  assert.equal((await db.doc(`${root}/only`).get()).data().guardianRecoveryRequired, true);
  assert.equal((await db.doc(`${root}/shared`).get()).data().guardianRecoveryRequired, undefined);
  assert.deepEqual((await db.doc(`${root}/shared/guardians/erase-retained`).get()).data(), survivor);
  assert.equal((await db.doc(`${root}/self`).get()).data().linkedUserId, null);
  const profile = (await db.doc(`${root}/self/private/profile`).get()).data();
  assert.equal(profile.contactEmail, undefined); assert.equal(profile.contactPhone, undefined); assert.equal(profile.operationalNotes, 'Organization history');
  assert.equal((await db.doc('teams/erase-roster/roster/shared').get()).exists, true);
  assert.equal((await db.doc(`organizationOwners/${uid}`).get()).exists, false);
  for (const [collection] of cleanupHooks) {
    const owned = await db.doc(`${collection}/erase-owned`).get();
    if (collection === 'importJobs') {
      assert.equal(owned.data().status, 'expired'); assert.equal(owned.data().ownerUid, null);
      assert.ok(owned.data().expiresAt.toMillis() <= Date.now());
    } else assert.equal(owned.exists, false);
    assert.equal((await db.doc(`${collection}/erase-other`).get()).exists, true);
  }
  for (const projection of ['participantLinks', 'organizationLinks', 'teamAccess', 'agenda', 'notifications', 'deviceTokens', 'notificationEndpoints']) assert.equal((await db.collection(`users/${uid}/${projection}`).get()).size, 0);
  const retainedCall = clients.find(app => app.name === 'erase-retained');
  const functions = getFunctions(retainedCall);
  const read = await httpsCallable(functions, 'getParticipantProfile')({ orgId: 'erase-only-org', participantId: 'shared' });
  assert.equal(read.data.participant.id, 'shared');
});
test('Auth failure remains denied and resumes without authentication, including crash after provider deletion', async () => {
  const uid = 'erase-auth-failure'; await actor(uid); await beginDeletion(uid);
  const fail = { deleteUser: async () => { throw new Error('Synthetic private provider error'); } };
  let state = await resumeDeletion(uid, 100, fail);
  assert.equal(state.status, 'pending'); assert.equal(state.lastError, 'CLEANUP_RETRY_REQUIRED');
  assert.equal((await db.doc(`users/${uid}`).get()).data().accountState, 'deleting');
  await auth.deleteUser(uid); // Provider succeeded but process stopped before completion checkpoint.
  state = await finish(uid); assert.equal(state.status, 'complete'); assert.equal(state.lastError, null);
  assert.equal((await db.doc(`users/${uid}`).get()).exists, false);
});
test('initial deletion requires recent authentication and cannot choose another account', async () => {
  const { deleteAccount } = require('./lib/accounts/deletion.js');
  const uid = 'erase-recent'; await actor(uid);
  await assert.rejects(deleteAccount.run({ auth: { uid, token: { auth_time: Math.floor(Date.now()/1000)-301 } }, data: {} }), error => error.details.domainCode === 'RECENT_LOGIN_REQUIRED');
  assert.equal((await db.doc(`accountDeletionJobs/${uid}`).get()).exists, false);
  await deleteAccount.run({ auth: { uid, token: { auth_time: Math.floor(Date.now()/1000) } }, data: { uid: 'erase-retained' } });
  assert.equal((await db.doc('users/erase-retained').get()).exists, true);
  assert.equal((await db.doc(`accountDeletionJobs/${uid}`).get()).data().status, 'complete');
});
test('a pending legacy attachment-audit job upgrades before authentication and applies the new privacy stages', async () => {
  const uid = 'erase-legacy-job'; await actor(uid);
  await db.doc(`organizations/erase-legacy/conversations/thread/messages/history`).set({
    schemaVersion: 2, authorUid: uid, body: 'Legacy retained history', sequence: 1, createdAt: Timestamp.now(),
  });
  await db.doc(`accountDeletionJobs/${uid}`).set({
    schemaVersion: 2, status: 'pending', stage: 20, cursor: null, pages: 20,
    membershipsRemoved: 0, recordsRemoved: 0, attempts: 1,
    createdAt: Timestamp.now(), updatedAt: Timestamp.now(), lastError: null,
  });
  const state = await finish(uid);
  assert.equal(state.schemaVersion, 3);
  const history = (await db.doc('organizations/erase-legacy/conversations/thread/messages/history').get()).data();
  assert.equal(history.authorUid, undefined);
  assert.deepEqual(history.authorIdentity, { kind: 'deleted', label: 'Deleted user' });
});
test('deletion tombstones retained communication history and removes unlinked uploads without copying content into audit data', async () => {
  const uid = 'erase-communication'; await actor(uid);
  const viewerUid = 'erase-history-viewer'; await actor(viewerUid);
  const orgId = 'erase-history-org';
  const { fingerprint } = require('./lib/operations/requests.js');
  const conversationId = fingerprint({ kind: 'conversation', orgId, scopeType: 'organization', scopeId: orgId, channel: 'household' });
  const messageId = 'retained-message';
  const bucket = getStorage(admin).bucket(`${projectId}.appspot.com`);
  await db.doc(`organizations/${orgId}`).set({
    schemaVersion: 2, revision: 1, status: 'active',
    features: { organizationV2: true, households: true, conversations: true, attachments: true },
  });
  await db.doc(`organizations/${orgId}/members/${viewerUid}`).set({
    schemaVersion: 2, orgId, userId: viewerUid, status: 'active', roles: ['orgAdmin'], programIds: [],
  });
  await db.doc(`organizations/${orgId}/conversations/${conversationId}`).set({
    schemaVersion: 2, orgId, scopeType: 'organization', scopeId: orgId, mode: 'adult', sequence: 1,
    pinnedMessageIds: [], revision: 1, createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
  });
  await db.doc(`organizations/${orgId}/conversations/${conversationId}/messages/${messageId}`).set({
    schemaVersion: 2, orgId, conversationId, authorUid: uid, moderatedBy: uid, sequence: 1,
    body: 'Retained shared history', attachmentIds: ['linked-file'], tombstoned: false,
    reactionCounts: { yes: 1 }, revision: 1, createdAt: Timestamp.now(),
  });
  await db.doc(`organizations/${orgId}/conversations/${conversationId}/messages/${messageId}/edits/1`).set({
    schemaVersion: 2, orgId, conversationId, messageId, actorUid: uid, previousRevision: 0,
    revision: 1, kind: 'edit', editedAt: Timestamp.now(),
  });
  await db.doc(`organizations/${orgId}/conversations/${conversationId}/messages/${messageId}/reactions/${uid}_yes`).set({
    schemaVersion: 2, orgId, conversationId, messageId, actorUid: uid, emoji: '👍', code: 'yes', createdAt: Timestamp.now(),
  });
  await db.doc(`organizations/${orgId}/messageSearch/${messageId}`).set({
    schemaVersion: 2, orgId, conversationId, tokens: ['retained', 'shared', 'history'], revision: 1,
    sequence: 1, createdAt: Timestamp.now(),
  });
  await db.doc(`organizations/${orgId}/staffNotes/organization_${orgId}/entries/retained-note`).set({
    schemaVersion: 2, orgId, scopeType: 'organization', scopeId: orgId,
    authorUid: uid, body: 'Retained private staff history', createdAt: Timestamp.now(),
  });
  await db.doc(`organizations/${orgId}/attachments/linked-file`).set({
    schemaVersion: 2, orgId, conversationId, ownerUid: uid, state: 'ready', messageId,
    fileName: 'retained.jpg', detectedType: 'image/jpeg', actualBytes: 4, sha256: 'linked-hash',
    objectPath: `quarantine/${orgId}/linked-file/2`, createdAt: Timestamp.now(),
  });
  await bucket.file(`quarantine/${orgId}/linked-file/2`).save(Buffer.from('keep'));
  for (let index = 0; index < 30; index += 1) {
    const attachmentId = `orphan-${String(index).padStart(2, '0')}`;
    const objectPath = `quarantine/${orgId}/${attachmentId}/1`;
    await db.doc(`organizations/${orgId}/attachments/${attachmentId}`).set({
      schemaVersion: 2, orgId, conversationId, ownerUid: uid,
      state: index % 2 ? 'quarantined' : 'ready', messageId: null,
      fileName: `private-${index}.jpg`, objectPath, createdAt: Timestamp.now(),
    });
    await bucket.file(objectPath).save(Buffer.from(`private-${index}`));
  }
  await db.doc(`organizations/${orgId}/attachmentSlots/deleting-owner`).set({
    schemaVersion: 2, orgId, conversationId, ownerUid: uid, activeIds: ['orphan-00'], updatedAt: Timestamp.now(),
  });

  await beginDeletion(uid);
  await Promise.all([resumeDeletion(uid, 2), resumeDeletion(uid, 2)]);
  const state = await finish(uid);

  assert.deepEqual(state.residualAudit.communications, {
    messagesTombstoned: 1,
    staffNotesTombstoned: 1,
    editActorsTombstoned: 1,
    moderationActorsTombstoned: 1,
    reactionsRemoved: 1,
  });
  assert.deepEqual(state.residualAudit.attachments, { linkedRetained: 1, unlinkedDeleted: 30, bytesRetained: true });
  const auditJson = JSON.stringify(state.residualAudit);
  assert.equal(auditJson.includes('private-0.jpg'), false);
  assert.equal(auditJson.includes('Retained shared history'), false);
  assert.equal(auditJson.includes(uid), false);

  const message = (await db.doc(`organizations/${orgId}/conversations/${conversationId}/messages/${messageId}`).get()).data();
  assert.equal(message.authorUid, undefined);
  assert.deepEqual(message.authorIdentity, { kind: 'deleted', label: 'Deleted user' });
  assert.equal(message.moderatedBy, undefined);
  assert.deepEqual(message.moderatorIdentity, { kind: 'deleted', label: 'Deleted user' });
  assert.equal(message.body, 'Retained shared history');
  assert.equal(message.reactionCounts.yes, 0);
  const edit = (await db.doc(`organizations/${orgId}/conversations/${conversationId}/messages/${messageId}/edits/1`).get()).data();
  assert.equal(edit.actorUid, undefined);
  assert.deepEqual(edit.actorIdentity, { kind: 'deleted', label: 'Deleted user' });
  assert.equal((await db.doc(`organizations/${orgId}/conversations/${conversationId}/messages/${messageId}/reactions/${uid}_yes`).get()).exists, false);
  const note = (await db.doc(`organizations/${orgId}/staffNotes/organization_${orgId}/entries/retained-note`).get()).data();
  assert.equal(note.authorUid, undefined);
  assert.deepEqual(note.authorIdentity, { kind: 'deleted', label: 'Deleted user' });

  const linked = (await db.doc(`organizations/${orgId}/attachments/linked-file`).get()).data();
  assert.equal(linked.ownerUid, undefined);
  assert.deepEqual(linked.ownerIdentity, { kind: 'deleted', label: 'Deleted user' });
  assert.equal((await bucket.file(linked.objectPath).exists())[0], true);
  assert.equal((await db.collectionGroup('attachments').where('ownerUid', '==', uid).get()).size, 0);
  assert.equal((await db.collectionGroup('attachmentSlots').where('ownerUid', '==', uid).get()).size, 0);
  for (let index = 0; index < 30; index += 1) {
    const attachmentId = `orphan-${String(index).padStart(2, '0')}`;
    assert.equal((await db.doc(`organizations/${orgId}/attachments/${attachmentId}`).get()).exists, false);
    assert.equal((await bucket.file(`quarantine/${orgId}/${attachmentId}/1`).exists())[0], false);
  }

  const viewerApp = clients.find(app => app.name === viewerUid);
  const viewerFunctions = getFunctions(viewerApp);
  const scope = { orgId, scopeType: 'organization', scopeId: orgId };
  const page = (await httpsCallable(viewerFunctions, 'listConversationMessages')({ ...scope, pageSize: 10 })).data;
  assert.equal(page.items[0].authorUid, null);
  assert.equal(page.items[0].authorLabel, 'Deleted user');
  assert.equal(page.items[0].mine, false);
  assert.equal(page.items[0].body, 'Retained shared history');
  assert.equal(page.items[0].attachments[0].fileName, 'retained.jpg');
  await assert.rejects(
    httpsCallable(viewerFunctions, 'editConversationMessage')({ requestId: 'cannot-claim-deleted', ...scope, messageId, text: 'Claimed edit', expectedRevision: 1 }),
    { code: 'functions/permission-denied' },
  );
  const search = (await httpsCallable(viewerFunctions, 'searchConversationMessages')({ ...scope, text: 'retained' })).data;
  assert.equal(search.items[0].authorUid, null);
  assert.equal(search.items[0].authorLabel, 'Deleted user');
  const notes = (await httpsCallable(viewerFunctions, 'listStaffNotes')({ ...scope, pageSize: 10 })).data;
  assert.equal(notes.items[0].authorUid, null);
  assert.equal(notes.items[0].authorLabel, 'Deleted user');
});
