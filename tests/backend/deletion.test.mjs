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
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth: adminAuth } = require('firebase-admin/auth');
requireEmulators();
let admin, db, auth, env, beginDeletion, resumeDeletion;
const clients = [];
before(async () => {
  admin = initAdmin({ projectId }); db = getFirestore(); auth = adminAuth();
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
    assert.equal(state.lastError, null);
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
  for (const projection of ['participantLinks', 'organizationLinks', 'teamAccess', 'agenda', 'deviceTokens', 'notificationEndpoints']) await db.doc(`users/${uid}/${projection}/pointer`).set({ private: 'Remove' });
  const { cleanupHooks } = require('./lib/accounts/deletion.js');
  for (const [collection, field] of cleanupHooks) {
    await db.doc(`${collection}/erase-owned`).set({ [field]: uid, token: 'synthetic-token' });
    await db.doc(`${collection}/erase-other`).set({ [field]: 'erase-retained' });
  }
  await db.doc(`organizationOwners/${uid}`).set({ enabled: true });
  await beginDeletion(uid); await finish(uid);
  assert.equal((await db.doc('organizations/erase-only-org').get()).data().administrativeControl, 'recoveryRequired');
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
  for (const projection of ['participantLinks', 'organizationLinks', 'teamAccess', 'agenda', 'deviceTokens', 'notificationEndpoints']) assert.equal((await db.collection(`users/${uid}/${projection}`).get()).size, 0);
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
