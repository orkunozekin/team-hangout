import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, collection, query, where, writeBatch, updateDoc, deleteDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
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
test('unrelated team gets and self-created coach membership are denied', async () => {
  const db = dbFor('outsider');
  await assertFails(getDoc(doc(db, 'teams/team-b')));
  await assertFails(setDoc(doc(db, 'teamMembers/team-b_outsider'), member('team-b', 'outsider', 'coach')));
  await assertFails(setDoc(doc(db, 'events/forged-coach-event'), event('team-b', 'outsider')));
});
test('old client team/join writes and all invite lookup reads are denied', async () => {
  const db = dbFor('outsider');
  const batch = writeBatch(db);
  batch.set(doc(db, 'teams/new-team'), team('outsider', 'CCCCCCCC'));
  batch.set(doc(db, 'inviteCodes/CCCCCCCC'), { code: 'CCCCCCCC', teamId: 'new-team', createdBy: 'outsider', createdAt: now });
  batch.set(doc(db, 'teamMembers/new-team_outsider'), member('new-team', 'outsider', 'coach'));
  await assertFails(batch.commit());
  await assertFails(getDoc(doc(db, 'inviteCodes/AAAAAAAA')));
  await assertFails(setDoc(doc(db, 'teamMembers/team-a_outsider'), member('team-a', 'outsider')));
  const mine = await assertSucceeds(getDocs(query(collection(dbFor('player-a'), 'teamMembers'), where('userId', '==', 'player-a'))));
  assert.equal(mine.size, 1);
  await assertSucceeds(getDoc(doc(dbFor('player-a'), 'teams/team-a')));
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
test('client mutations cannot change authority or references, including for coaches/admins', async () => {
  for (const uid of ['coach-a', 'admin']) {
    const db = dbFor(uid);
    await assertFails(updateDoc(doc(db, 'teams/team-a'), { inviteCode: 'DDDDDDDD' }));
    await assertFails(updateDoc(doc(db, 'teams/team-a'), { createdBy: 'outsider', orgId: 'forged' }));
    await assertFails(updateDoc(doc(db, 'teamMembers/team-a_player-a'), { role: 'coach', teamId: 'team-b' }));
    await assertFails(updateDoc(doc(db, 'events/event-a'), { teamId: 'team-b' }));
    await assertFails(setDoc(doc(db, 'events/coach-write'), event('team-a', uid)));
    await assertFails(deleteDoc(doc(db, 'inviteCodes/AAAAAAAA')));
    await assertFails(getDocs(collection(db, 'inviteCodes')));
    await assertFails(getDocs(collection(db, 'commandRequests')));
    await assertFails(getDoc(doc(db, 'organizations/org-a/conversations/channel-a')));
    await assertFails(getDoc(doc(db, 'organizations/org-a/conversations/channel-a/messages/message-a')));
    await assertFails(getDoc(doc(db, 'organizations/org-a/conversations/channel-a/messages/message-a/reactions/player-a_yes')));
    await assertFails(getDoc(doc(db, 'organizations/org-a/conversations/channel-a/messages/message-a/edits/1')));
    await assertFails(getDoc(doc(db, 'organizations/org-a/messageSearch/message-a')));
    await assertFails(setDoc(doc(db, 'organizations/org-a/messageSearch/message-a'), { tokens: ['private'] }));
    await assertFails(getDoc(doc(db, 'organizations/org-a/attachments/file-a')));
    await assertFails(setDoc(doc(db, 'organizations/org-a/attachments/file-a'), { state: 'ready' }));
    await assertFails(getDoc(doc(db, 'organizations/org-a/attachmentSlots/slot-a')));
    await assertFails(setDoc(doc(db, 'organizations/org-a/attachmentSlots/slot-a'), { activeIds: ['file-a'] }));
    await assertFails(getDoc(doc(db, 'organizations/org-a/staffNotes/team_team-a/entries/note-a')));
    await assertFails(setDoc(doc(db, 'organizations/org-a/staffNotes/team_team-a/entries/note-a'), { body: 'private' }));
    await assertFails(getDoc(doc(db, 'organizations/org-a/rsvpReminders/event-a')));
    await assertFails(getDoc(doc(db, 'organizations/org-a/deliveryIssues/issue-a')));
    await assertFails(getDoc(doc(db, 'organizations/org-a/criticalUpdates/update-a')));
    await assertFails(setDoc(doc(db, 'organizations/org-a/rsvpReminders/event-a'), { state: 'scheduled' }));
  }
});
test('profile field allowlists preserve server-owned authority and immutable identity', async () => {
  const db = dbFor('player-a');
  for (const patch of [{ appRole: 'superAdmin' }, { uid: 'coach-a' }, { email: 'other@example.test' }, { accountState: 'active' }, { orgId: 'org-b' }, { activeTeamId: 'team-b' }]) {
    await assertFails(updateDoc(doc(db, 'users/player-a'), { ...patch, updatedAt: serverTimestamp() }));
  }
});
test('platform admin support remains separate from tenant data access', async () => {
  const db = dbFor('admin');
  await assertFails(getDocs(collection(db, 'teams')));
  await assertSucceeds(getDoc(doc(db, 'teams/team-b')));
  await assertSucceeds(getDoc(doc(db, 'users/coach-a')));
  await assertFails(updateDoc(doc(db, 'teams/team-b'), { name: 'Support rename' }));
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

test('legitimate profile preferences and platform role support survive the allowlists', async () => {
  await assertSucceeds(updateDoc(doc(dbFor('player-a'), 'users/player-a'), { displayName: 'Updated player', activeTeamId: 'team-a', updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(dbFor('admin'), 'users/admin'), { activeTeamId: 'team-b', updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(dbFor('admin'), 'users/outsider'), { appRole: 'superAdmin', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(dbFor('admin'), 'users/player-a'), { uid: 'forged', updatedAt: serverTimestamp() }));
  const db = env.authenticatedContext('new-user', { email: 'new-user@example.test' }).firestore();
  const profile = { ...user('new-user'), createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
  await assertFails(setDoc(doc(db, 'users/new-user'), { ...profile, accountState: 'active' }));
  await assertSucceeds(setDoc(doc(db, 'users/new-user'), profile));
});

test('removed membership does not block unrelated profile edits or clearing stale preference', async () => {
  await env.withSecurityRulesDisabled(async context => {
    await updateDoc(doc(context.firestore(), 'users/player-a'), { activeTeamId: 'team-a' });
    await deleteDoc(doc(context.firestore(), 'teamMembers/team-a_player-a'));
  });
  const db = dbFor('player-a');
  await assertSucceeds(updateDoc(doc(db, 'users/player-a'), { displayName: 'Former player', updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, 'users/player-a'), { activeTeamId: 'team-b', updatedAt: serverTimestamp() }));
  await assertSucceeds(updateDoc(doc(db, 'users/player-a'), { activeTeamId: null, updatedAt: serverTimestamp() }));
  await assertFails(updateDoc(doc(db, 'users/player-a'), { activeTeamId: 'team-a', updatedAt: serverTimestamp() }));
});

test('v2 hierarchy, teams, events and audit data cannot leak through legacy reads or support', async () => {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, 'teams/v2-team'), { ...team('coach-a', 'V2V2V2V2'), orgId: 'org-a', schemaVersion: 2 });
    await setDoc(doc(db, 'teamMembers/v2-team_coach-a'), { ...member('v2-team', 'coach-a', 'coach'), orgId: 'org-a', status: 'active', roles: ['coach'], schemaVersion: 2 });
    await setDoc(doc(db, 'events/v2-event'), { ...event('v2-team', 'coach-a'), orgId: 'org-a', schemaVersion: 2, publicationState: 'staged' });
    await setDoc(doc(db, 'organizations/org-a/members/coach-a'), { roles: ['orgAdmin'], status: 'active' });
  });
  for (const uid of ['coach-a', 'player-a', 'outsider', 'admin']) {
    const db = dbFor(uid);
    for (const path of ['teams/v2-team', 'events/v2-event', 'organizations/org-a', 'organizations/org-a/members/coach-a', 'organizations/org-a/programs/p', 'organizations/org-a/audit/a', 'organizationOwners/outsider', 'calendarSubscriptions/private-hash', 'commandRequests/calendar-receipt']) {
      await assertFails(getDoc(doc(db, path)));
      await assertFails(setDoc(doc(db, path), { orgId: 'org-a' }));
    }
    await assertFails(getDocs(query(collection(db, 'events'), where('teamId', '==', 'v2-team'), where('deletedAt', '==', null))));
    await assertFails(deleteDoc(doc(db, 'teamMembers/v2-team_coach-a')));
  }
  // A caller may inspect their own non-sensitive grant, but cannot mutate it or read another grant.
  await assertSucceeds(getDoc(doc(dbFor('coach-a'), 'teamMembers/v2-team_coach-a')));
  await assertFails(getDoc(doc(dbFor('admin'), 'teamMembers/v2-team_coach-a')));
});
