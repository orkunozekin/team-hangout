import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, collection, query, where, writeBatch, updateDoc, deleteDoc, Timestamp } from 'firebase/firestore';
import { projectId, requireEmulators } from './fixtures.mjs';
requireEmulators();
let env;
const now = Timestamp.fromMillis(1791586800000);
const user = (uid, appRole = 'user') => ({ uid, email: `${uid}@example.test`, displayName: uid, appRole, activeTeamId: null, createdAt: now, updatedAt: now });
const team = (uid, inviteCode) => ({ name: 'Synthetic team', inviteCode, createdBy: uid, createdAt: now, updatedAt: now });
const member = (teamId, uid, role = 'player') => ({ teamId, userId: uid, role, displayName: uid, joinedAt: now });
const event = (teamId, uid, deletedAt = null) => ({ teamId, createdBy: uid, type: 'practice', title: 'Synthetic practice', date: now, time: '18:00', createdAt: now, updatedAt: now, deletedAt });
const dbFor = (uid) => env.authenticatedContext(uid).firestore();
before(async () => { env = await initializeTestEnvironment({ projectId, firestore: { host: '127.0.0.1', port: 8080, rules: readFileSync('firestore.rules', 'utf8') } }); });
after(async () => { await env?.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const records = {
      'users/coach-a': user('coach-a'), 'users/player-a': user('player-a'), 'users/outsider': user('outsider'), 'users/admin': user('admin', 'superAdmin'),
      'teams/team-a': team('coach-a', 'AAAAAAAA'), 'teams/team-b': team('coach-b', 'BBBBBBBB'),
      'teamMembers/team-a_coach-a': member('team-a', 'coach-a', 'coach'), 'teamMembers/team-a_player-a': member('team-a', 'player-a'),
      'inviteCodes/AAAAAAAA': { code: 'AAAAAAAA', teamId: 'team-a', createdBy: 'coach-a', createdAt: now },
      'events/event-a': event('team-a', 'coach-a'), 'events/event-b': event('team-b', 'coach-b'), 'events/deleted': event('team-a', 'coach-a', now),
      'organizations/org-a': { name: 'Synthetic A' }, 'organizations/org-b': { name: 'Synthetic B' },
      'organizations/org-b/participants/child-b/private/profile': { notes: 'Synthetic private note' },
    };
    const batch = writeBatch(db);
    for (const [path, data] of Object.entries(records)) batch.set(doc(db, path), data);
    await batch.commit();
  });
});
test('KNOWN VULNERABILITY baseline: unrelated signed-in user can get a team', async () => {
  const result = await assertSucceeds(getDoc(doc(dbFor('outsider'), 'teams/team-b')));
  assert.equal(result.data().inviteCode, 'BBBBBBBB');
});
test('KNOWN VULNERABILITY baseline: self-created coach membership grants event writes', async () => {
  const db = dbFor('outsider');
  await assertSucceeds(setDoc(doc(db, 'teamMembers/team-b_outsider'), member('team-b', 'outsider', 'coach')));
  await assertSucceeds(setDoc(doc(db, 'events/forged-coach-event'), event('team-b', 'outsider')));
});
test('legacy team creation batch, player join and own membership discovery work', async () => {
  const db = dbFor('outsider');
  const batch = writeBatch(db);
  batch.set(doc(db, 'teams/new-team'), team('outsider', 'CCCCCCCC'));
  batch.set(doc(db, 'inviteCodes/CCCCCCCC'), { code: 'CCCCCCCC', teamId: 'new-team', createdBy: 'outsider', createdAt: now });
  batch.set(doc(db, 'teamMembers/new-team_outsider'), member('new-team', 'outsider', 'coach'));
  await assertSucceeds(batch.commit());
  await assertSucceeds(getDoc(doc(db, 'inviteCodes/AAAAAAAA')));
  await assertSucceeds(setDoc(doc(db, 'teamMembers/team-a_outsider'), member('team-a', 'outsider')));
  const mine = await assertSucceeds(getDocs(query(collection(db, 'teamMembers'), where('userId', '==', 'outsider'))));
  assert.equal(mine.size, 2);
  await assertFails(setDoc(doc(db, 'teamMembers/team-b_outsider'), member('team-b', 'outsider')));
});
test('legacy event reads require membership and exclude soft-deleted events', async () => {
  const db = dbFor('player-a');
  await assertSucceeds(getDoc(doc(db, 'events/event-a')));
  const events = await assertSucceeds(getDocs(query(collection(db, 'events'), where('teamId', '==', 'team-a'), where('deletedAt', '==', null))));
  assert.equal(events.size, 1);
  await assertFails(getDoc(doc(db, 'events/event-b')));
  await assertFails(getDoc(doc(db, 'events/deleted')));
  await assertFails(getDocs(collection(db, 'events')));
  await assertFails(setDoc(doc(db, 'events/player-write'), event('team-a', 'player-a')));
  await assertFails(setDoc(doc(dbFor('coach-a'), 'events/forged-actor'), event('team-a', 'outsider')));
});
test('invite rotation invalidates old lookup, and players cannot rotate', async () => {
  const db = dbFor('coach-a');
  const batch = writeBatch(db);
  batch.delete(doc(db, 'inviteCodes/AAAAAAAA'));
  batch.set(doc(db, 'inviteCodes/DDDDDDDD'), { code: 'DDDDDDDD', teamId: 'team-a', createdBy: 'coach-a', createdAt: now });
  batch.update(doc(db, 'teams/team-a'), { inviteCode: 'DDDDDDDD', updatedAt: now });
  await assertSucceeds(batch.commit());
  assert.equal((await getDoc(doc(dbFor('outsider'), 'inviteCodes/AAAAAAAA'))).exists(), false);
  await assertFails(updateDoc(doc(dbFor('player-a'), 'teams/team-a'), { inviteCode: 'EEEEEEEE' }));
  await assertFails(deleteDoc(doc(dbFor('player-a'), 'inviteCodes/DDDDDDDD')));
  await assertFails(getDocs(collection(db, 'inviteCodes')));
});
test('platform admin support remains separate from tenant data access', async () => {
  const db = dbFor('admin');
  assert.equal((await assertSucceeds(getDocs(collection(db, 'teams')))).size, 2);
  await assertSucceeds(getDoc(doc(db, 'users/coach-a')));
  await assertSucceeds(updateDoc(doc(db, 'teams/team-b'), { name: 'Support rename' }));
  await assertSucceeds(getDoc(doc(db, 'events/event-b')));
  await assertFails(getDocs(collection(dbFor('outsider'), 'teams')));
  await assertFails(updateDoc(doc(dbFor('outsider'), 'users/outsider'), { appRole: 'superAdmin' }));
});
test('v2 tenant records remain denied for all legacy actors, including cross-org references', async () => {
  for (const uid of ['coach-a', 'player-a', 'outsider', 'admin']) {
    const db = dbFor(uid);
    for (const path of ['organizations/org-a', 'organizations/org-b', 'organizations/org-b/participants/child-b/private/profile', 'users/outsider/teamAccess/team-b']) {
      await assertFails(getDoc(doc(db, path)));
      await assertFails(setDoc(doc(db, path), { orgId: 'org-a', teamId: 'team-b' }));
    }
  }
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), 'teams/team-a')));
});
