import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp: initializeAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getAuth: getAdminAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { projectId, requireEmulators } from './fixtures.mjs';
requireEmulators();
let admin, client, db, auth, callable;
before(() => {
  admin = initializeAdmin({ projectId });
  db = getFirestore(admin); auth = getAdminAuth(admin);
  client = initializeApp({ projectId, apiKey: 'demo-key', authDomain: `${projectId}.firebaseapp.com` }, 'deletion-test');
  connectAuthEmulator(getAuth(client), 'http://127.0.0.1:9099', { disableWarnings: true });
  const functions = getFunctions(client);
  connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  callable = httpsCallable(functions, 'deleteAccount');
});
after(async () => { await deleteApp(client); await deleteAdmin(admin); });
test('deleteAccount callable rejects unauthenticated requests', async () => {
  await assert.rejects(callable(), { code: 'functions/unauthenticated' });
});
test('deleteAccount removes caller Auth/profile/memberships while preserving other users and history', async () => {
  const uid = 'delete-fixture';
  await auth.createUser({ uid, email: 'delete@example.test', password: 'SyntheticPassword123!' });
  await signInWithEmailAndPassword(getAuth(client), 'delete@example.test', 'SyntheticPassword123!');
  await Promise.all([
    db.doc(`users/${uid}`).set({ uid }),
    db.doc(`teamMembers/delete-team_${uid}`).set({ userId: uid, teamId: 'delete-team', role: 'coach' }),
    db.doc(`teamMembers/other-team_${uid}`).set({ userId: uid, teamId: 'other-team', role: 'player' }),
    db.doc('teamMembers/delete-team_survivor').set({ userId: 'survivor', teamId: 'delete-team' }),
    db.doc('users/survivor').set({ uid: 'survivor' }),
    db.doc('teams/delete-team').set({ createdBy: uid }),
    db.doc('events/delete-event').set({ teamId: 'delete-team', createdBy: uid }),
  ]);
  const { data } = await callable();
  assert.deepEqual(data, { ok: true, membershipsRemoved: 2 });
  assert.equal((await db.doc(`users/${uid}`).get()).exists, false);
  assert.equal((await db.collection('teamMembers').where('userId', '==', uid).get()).size, 0);
  await assert.rejects(auth.getUser(uid), { code: 'auth/user-not-found' });
  assert.deepEqual((await callable()).data, { ok: true, membershipsRemoved: 0 });
  for (const path of ['users/survivor', 'teamMembers/delete-team_survivor', 'teams/delete-team', 'events/delete-event']) {
    assert.equal((await db.doc(path).get()).exists, true);
  }
});
