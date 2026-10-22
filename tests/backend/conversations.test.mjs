import { createHmac } from 'node:crypto';
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
const fail = async (uid, name, data = {}) => { try { await call(uid, name, data); assert.fail('expected rejection'); } catch (error) { return error; } };
const meta = { schemaVersion: 2, revision: 1, status: 'active', createdAt: Timestamp.now(), updatedAt: Timestamp.now() };
const team = { orgId: 'talk-org', scopeType: 'team', scopeId: 'talk-team' };
before(async () => {
  admin = adminApp({ projectId }); db = getFirestore(admin);
  for (const uid of ['talk-admin', 'talk-staff', 'talk-coach', 'talk-guardian', 'talk-new-guardian', 'talk-self', 'talk-outsider']) {
    const app = initializeApp({ projectId, apiKey: 'demo-key' }, uid); apps[uid] = app;
    connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), '127.0.0.1', 5001);
    await adminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password: 'SyntheticPassword123!' });
    await db.doc(`users/${uid}`).set({ uid, email: `${uid}@example.test`, appRole: 'user' });
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, 'SyntheticPassword123!');
  }
  await db.doc('organizations/talk-org').set({ ...meta, name: 'Synthetic Talk', features: { organizationV2: true, households: true, conversations: true }, policies: {} });
  await db.doc('organizations/talk-org/programs/talk-program').set({ ...meta, orgId: 'talk-org', name: 'Program' });
  await db.doc('organizations/talk-org/divisions/talk-division').set({ ...meta, orgId: 'talk-org', programId: 'talk-program', name: 'Division' });
  await db.doc('organizations/talk-org/members/talk-admin').set({ ...meta, orgId: 'talk-org', userId: 'talk-admin', roles: ['orgAdmin'], programIds: [] });
  await db.doc('organizations/talk-org/members/talk-staff').set({ ...meta, orgId: 'talk-org', userId: 'talk-staff', roles: ['programStaff'], programIds: ['talk-program'] });
  await db.doc('teams/talk-team').set({ ...meta, orgId: 'talk-org', programId: 'talk-program', seasonId: 'talk-season', divisionId: 'talk-division', name: 'Falcons' });
  await db.doc('teamMembers/talk-team_talk-coach').set({ ...meta, orgId: 'talk-org', teamId: 'talk-team', userId: 'talk-coach', roles: ['coach'] });
  await db.doc('organizations/talk-org/participants/talk-child').set({ ...meta, orgId: 'talk-org', displayName: 'Child', linkedUserId: 'talk-self' });
  await db.doc('teams/talk-team/roster/talk-child').set({ ...meta, orgId: 'talk-org', participantId: 'talk-child' });
  await db.doc('organizations/talk-org/participants/talk-child/guardians/talk-guardian').set({ ...meta, orgId: 'talk-org', participantId: 'talk-child', userId: 'talk-guardian', permissions: { viewSchedule: true, respond: true } });
  await db.doc('events/talk-event').set({ ...meta, orgId: 'talk-org', programId: 'talk-program', teamId: 'talk-team', teamIds: ['talk-team'], title: 'Practice', status: 'scheduled', publicationState: 'published', publicationOperationId: null, deletedAt: null, timeZone: 'America/Chicago' });
});
after(async () => { await Promise.all(Object.values(apps).map(app => deleteApp(app))); if (admin) await deleteAdmin(admin); });

test('youth channels stay closed until the organization policy is approved', async () => {
  const blocked = await fail('talk-guardian', 'postConversationMessage', { requestId: 'youth-blocked', ...team, text: 'Can I post?' });
  assert.equal(blocked.code, 'functions/failed-precondition');
  assert.equal(blocked.details?.domainCode, 'YOUTH_POLICY');
  const direct = await fail('talk-guardian', 'postConversationMessage', { requestId: 'direct', orgId: 'talk-org', scopeType: 'direct', scopeId: 'talk-coach', text: 'private' });
  assert.equal(direct.details?.domainCode, 'YOUTH_POLICY');
  const posted = await call('talk-staff', 'postConversationMessage', { requestId: 'staff-post', ...team, text: 'Practice is at the north field' });
  const page = await call('talk-guardian', 'listConversationMessages', { ...team, pageSize: 10 });
  assert.equal(page.mode, 'youth');
  assert.equal(page.youthPosting, 'closed');
  assert.equal(page.items[0].body, 'Practice is at the north field');
  await db.doc('organizations/talk-org').update({ 'policies.youthChannels': 'approved' });
  const allowed = await call('talk-guardian', 'postConversationMessage', { requestId: 'guardian-post', ...team, text: 'We will be there' });
  assert.equal(allowed.sequence > posted.sequence, true);
  const replay = await call('talk-guardian', 'postConversationMessage', { requestId: 'guardian-post', ...team, text: 'We will be there' });
  assert.equal(replay.id, allowed.id);
});

test('new guardians can only read and interact with messages created after their grant became active', async () => {
  const before = await call('talk-coach', 'postConversationMessage', { requestId: 'guardian-cutoff-before', ...team, text: 'Beforegrantword stays private' });
  const grantedAt = Timestamp.now();
  await db.doc('organizations/talk-org/participants/talk-child/guardians/talk-new-guardian').set({
    ...meta,
    orgId: 'talk-org',
    participantId: 'talk-child',
    userId: 'talk-new-guardian',
    permissions: { viewSchedule: true, respond: true },
    grantedAt,
    createdAt: grantedAt,
    updatedAt: grantedAt,
  });
  const after = await call('talk-coach', 'postConversationMessage', { requestId: 'guardian-cutoff-after', ...team, text: 'Aftergrantword is visible' });

  const page = await call('talk-new-guardian', 'listConversationMessages', { ...team, pageSize: 50 });
  assert.equal(page.items.some(row => row.id === before.id), false);
  assert.equal(page.items.some(row => row.id === after.id), true);
  assert.equal(page.pinnedIds.includes(before.id), false);

  const oldSearch = await call('talk-new-guardian', 'searchConversationMessages', { ...team, text: 'beforegrantword' });
  assert.equal(oldSearch.items.length, 0);
  const newSearch = await call('talk-new-guardian', 'searchConversationMessages', { ...team, text: 'aftergrantword' });
  assert.equal(newSearch.items.some(row => row.id === after.id), true);

  const edit = await fail('talk-new-guardian', 'editConversationMessage', {
    requestId: 'guardian-cutoff-edit', ...team, messageId: before.id, text: 'Should stay hidden', expectedRevision: 0,
  });
  assert.equal(edit.code, 'functions/permission-denied');
  const reaction = await fail('talk-new-guardian', 'reactToConversationMessage', {
    requestId: 'guardian-cutoff-reaction', ...team, messageId: before.id, emoji: '👍', expectedRevision: 0,
  });
  assert.equal(reaction.code, 'functions/permission-denied');
});

test('a revoked guardian and a removed roster member lose the channel', async () => {
  await db.doc('organizations/talk-org/participants/talk-child/guardians/talk-guardian').update({ status: 'revoked' });
  const revoked = await fail('talk-guardian', 'listConversationMessages', team);
  assert.equal(revoked.code, 'functions/permission-denied');
  await db.doc('organizations/talk-org/participants/talk-child/guardians/talk-guardian').update({ status: 'active' });
  await db.doc('teams/talk-team/roster/talk-child').update({ status: 'removed' });
  const removed = await fail('talk-self', 'listConversationMessages', team);
  assert.equal(removed.code, 'functions/permission-denied');
  const outsider = await fail('talk-outsider', 'listConversationMessages', team);
  assert.equal(outsider.code, 'functions/permission-denied');
  await db.doc('teams/talk-team/roster/talk-child').update({ status: 'active' });
});

test('staff notes stay out of household channels, notifications, and guardian reads', async () => {
  const note = await call('talk-staff', 'postStaffNote', { requestId: 'private-note', ...team, text: 'Guardian phone is private' });
  assert.ok(note.id);
  const channel = await call('talk-guardian', 'listConversationMessages', { ...team, pageSize: 25 });
  assert.equal(JSON.stringify(channel).includes('Guardian phone is private'), false);
  const notes = await fail('talk-guardian', 'listStaffNotes', team);
  assert.equal(notes.code, 'functions/permission-denied');
  const coach = await fail('talk-coach', 'listStaffNotes', team);
  assert.equal(coach.code, 'functions/permission-denied');
  assert.equal((await db.collection('users/talk-guardian/notifications').get()).size, 0);
  assert.equal((await db.collection('organizations/talk-org/outbox').get()).size, 0);
  const staff = await call('talk-admin', 'listStaffNotes', { ...team, pageSize: 10 });
  assert.equal(staff.items.some(row => row.body === 'Guardian phone is private'), true);
});

test('coaches can pin, guardians cannot, and staff can tombstone a message', async () => {
  const first = await call('talk-coach', 'postConversationMessage', { requestId: 'pin-one', ...team, text: 'Bring water' });
  const beforePin = (await db.collection('organizations/talk-org/conversations').get()).docs[0].data().revision ?? 0;
  const pin = await call('talk-coach', 'setConversationPin', { requestId: 'pin', ...team, messageId: first.id, pinned: true });
  assert.deepEqual(pin.pinnedIds, [first.id]);
  const pinnedDoc = (await db.collection('organizations/talk-org/conversations').get()).docs[0];
  assert.equal(pinnedDoc.data().revision, beforePin + 1);
  const guardianPin = await fail('talk-guardian', 'setConversationPin', { requestId: 'guardian-pin', ...team, messageId: first.id, pinned: true });
  assert.equal(guardianPin.code, 'functions/permission-denied');
  const coachModerate = await fail('talk-coach', 'moderateConversationMessage', { requestId: 'coach-moderate', ...team, messageId: first.id, reason: 'cleanup' });
  assert.equal(coachModerate.code, 'functions/permission-denied');
  const beforeModerate = pinnedDoc.data().revision;
  await call('talk-staff', 'moderateConversationMessage', { requestId: 'staff-moderate', ...team, messageId: first.id, reason: 'cleanup' });
  const moderated = await pinnedDoc.ref.collection('messages').doc(first.id).get();
  assert.equal(moderated.data().revision, 1);
  assert.equal((await pinnedDoc.ref.get()).data().revision, beforeModerate + 1);
  const page = await call('talk-self', 'listConversationMessages', { ...team, pageSize: 25 });
  const hidden = page.items.find(row => row.id === first.id);
  assert.equal(hidden.tombstoned, true);
  assert.equal(hidden.body, null);
  assert.equal(JSON.stringify(page).includes('Bring water'), false);
});

test('a removed staff member cannot post and an unpublished event stays hidden from households', async () => {
  await db.doc('organizations/talk-org/members/talk-staff').update({ status: 'revoked' });
  const removed = await fail('talk-staff', 'postConversationMessage', { requestId: 'removed-staff', ...team, text: 'Still here' });
  assert.equal(removed.code, 'functions/permission-denied');
  await db.doc('organizations/talk-org/members/talk-staff').update({ status: 'active' });
  await db.doc('events/talk-staged').set({ ...meta, orgId: 'talk-org', programId: 'talk-program', teamId: 'talk-team', teamIds: ['talk-team'], publicationState: 'staged', publicationOperationId: 'talk-op', deletedAt: null, status: 'scheduled' });
  const hidden = await fail('talk-guardian', 'listConversationMessages', { orgId: 'talk-org', scopeType: 'event', scopeId: 'talk-staged' });
  assert.equal(hidden.code, 'functions/permission-denied');
  const staff = await call('talk-staff', 'listConversationMessages', { orgId: 'talk-org', scopeType: 'event', scopeId: 'talk-staged', pageSize: 5 });
  assert.equal(staff.items.length, 0);
});

test('archived participants, foreign guardian paths, and mis-scoped admin grants do not open channels', async () => {
  await db.doc('organizations/talk-org/participants/talk-child').update({ status: 'archived' });
  const archived = await fail('talk-guardian', 'listConversationMessages', team);
  assert.equal(archived.code, 'functions/permission-denied');
  await db.doc('organizations/talk-org/participants/talk-child').update({ status: 'active' });
  await db.doc('organizations/other-org/participants/talk-child/guardians/talk-outsider').set({ ...meta, orgId: 'talk-org', participantId: 'talk-child', userId: 'talk-outsider', permissions: { viewSchedule: true } });
  const forged = await fail('talk-outsider', 'listConversationMessages', team);
  assert.equal(forged.code, 'functions/permission-denied');
  await db.doc('organizations/other-org/participants/talk-child/guardians/talk-outsider').delete();
  await db.doc('organizations/talk-org/members/talk-outsider').set({ ...meta, orgId: 'other-org', userId: 'talk-outsider', roles: ['orgAdmin'], programIds: [] });
  const admin = await fail('talk-outsider', 'listStaffNotes', team);
  assert.equal(admin.code, 'functions/permission-denied');
  const post = await fail('talk-outsider', 'postConversationMessage', { requestId: 'forged-admin', ...team, text: 'Wrong organization' });
  assert.equal(post.code, 'functions/permission-denied');
  await db.doc('organizations/talk-org/members/talk-outsider').delete();
  await db.doc('organizations/talk-org/participants/talk-a').set({ ...meta, orgId: 'talk-org', displayName: 'Profile only' });
  await db.doc('organizations/talk-org/participants/talk-a/guardians/talk-outsider').set({ ...meta, orgId: 'talk-org', participantId: 'talk-a', userId: 'talk-outsider', permissions: { viewProfile: true } });
  await db.doc('organizations/talk-org/participants/talk-z').set({ ...meta, orgId: 'talk-org', displayName: 'Schedule' });
  await db.doc('organizations/talk-org/participants/talk-z/guardians/talk-outsider').set({ ...meta, orgId: 'talk-org', participantId: 'talk-z', userId: 'talk-outsider', permissions: { viewSchedule: true } });
  const announcements = await call('talk-outsider', 'listConversationMessages', { orgId: 'talk-org', scopeType: 'organization', scopeId: 'talk-org', pageSize: 5 });
  assert.equal(announcements.mode, 'adult');
  await db.doc('organizations/talk-org/participants/talk-z').update({ status: 'archived' });
  const archivedSchedule = await fail('talk-outsider', 'listConversationMessages', { orgId: 'talk-org', scopeType: 'organization', scopeId: 'talk-org' });
  assert.equal(archivedSchedule.code, 'functions/permission-denied');
  await db.doc('organizations/talk-org/participants/talk-z').update({ status: 'active' });
});

test('message pages follow the server sequence and reject a cursor from another message', async () => {
  const first = await call('talk-coach', 'postConversationMessage', { requestId: 'seq-one', ...team, text: 'Sequence alpha' });
  const second = await call('talk-coach', 'postConversationMessage', { requestId: 'seq-two', ...team, text: 'Sequence beta' });
  const third = await call('talk-coach', 'postConversationMessage', { requestId: 'seq-three', ...team, text: 'Sequence gamma' });
  const page = await call('talk-self', 'listConversationMessages', { ...team, pageSize: 2 });
  assert.deepEqual(page.items.map(row => row.id), [third.id, second.id]);
  assert.equal(page.items[0].sequence > page.items[1].sequence, true);
  assert.equal(page.nextCursor, `s${second.sequence}_${second.id}`);
  const older = await call('talk-self', 'listConversationMessages', { ...team, pageSize: 2, cursor: page.nextCursor });
  assert.equal(older.items[0].id, first.id);
  assert.equal(older.items.some(row => row.id === third.id), false);
  const tampered = await fail('talk-self', 'listConversationMessages', { ...team, pageSize: 2, cursor: `s${first.sequence + 9}_${second.id}` });
  assert.equal(tampered.code, 'functions/invalid-argument');
  const foreign = await fail('talk-self', 'listConversationMessages', { ...team, pageSize: 2, cursor: `s${first.sequence}_not-this-message` });
  assert.equal(foreign.code, 'functions/invalid-argument');
});

test('authors can edit their own text, old words leave search, and audits stay redacted', async () => {
  const posted = await call('talk-guardian', 'postConversationMessage', { requestId: 'edit-source', ...team, text: 'Zephyrlane practice is early' });
  const listed = await call('talk-guardian', 'listConversationMessages', { ...team, pageSize: 10 });
  const current = listed.items.find(row => row.id === posted.id);
  assert.equal(current.revision, 0);
  assert.equal(current.mine, true);
  const stranger = await fail('talk-coach', 'editConversationMessage', { requestId: 'coach-edit', ...team, messageId: posted.id, text: 'Coach rewrite', expectedRevision: 0 });
  assert.equal(stranger.code, 'functions/permission-denied');
  const edited = await call('talk-guardian', 'editConversationMessage', { requestId: 'guardian-edit', ...team, messageId: posted.id, text: 'Zephyrlane practice moved', expectedRevision: 0 });
  assert.equal(edited.revision, 1);
  const replay = await call('talk-guardian', 'editConversationMessage', { requestId: 'guardian-edit', ...team, messageId: posted.id, text: 'Zephyrlane practice moved', expectedRevision: 0 });
  assert.equal(replay.revision, 1);
  const reused = await fail('talk-guardian', 'editConversationMessage', { requestId: 'guardian-edit', ...team, messageId: posted.id, text: 'A different sentence', expectedRevision: 1 });
  assert.equal(reused.code, 'functions/already-exists');
  const stale = await fail('talk-guardian', 'editConversationMessage', { requestId: 'guardian-edit-stale', ...team, messageId: posted.id, text: 'Zephyrlane practice moved again', expectedRevision: 0 });
  assert.equal(stale.details?.domainCode, 'STALE_REVISION');
  const page = await call('talk-self', 'listConversationMessages', { ...team, pageSize: 25 });
  const row = page.items.find(item => item.id === posted.id);
  assert.equal(row.body, 'Zephyrlane practice moved');
  assert.equal(typeof row.editedAt, 'string');
  assert.equal(JSON.stringify(page).includes('early'), false);
  const found = await call('talk-guardian', 'searchConversationMessages', { ...team, text: 'moved' });
  assert.equal(found.partial, false);
  assert.equal(found.items.some(item => item.id === posted.id && item.body === 'Zephyrlane practice moved'), true);
  const staleSearch = await call('talk-guardian', 'searchConversationMessages', { ...team, text: 'early' });
  assert.equal(staleSearch.items.some(item => item.id === posted.id), false);
  const { fingerprint } = require('./lib/operations/requests.js');
  const conversationId = fingerprint({ kind: 'conversation', orgId: 'talk-org', scopeType: 'team', scopeId: 'talk-team', channel: 'household' });
  const audit = await db.collection(`organizations/talk-org/conversations/${conversationId}/messages/${posted.id}/edits`).get();
  assert.equal(audit.size, 1);
  assert.equal(JSON.stringify(audit.docs[0].data()).includes('early'), false);
  const indexed = await db.doc(`organizations/talk-org/messageSearch/${posted.id}`).get();
  assert.deepEqual(indexed.data().tokens.includes('early'), false);
  assert.equal(indexed.data().tokens.includes('moved'), true);
  assert.equal(indexed.data().revision, 1);
  const direct = await fail('talk-guardian', 'editConversationMessage', { requestId: 'direct-edit', orgId: 'talk-org', scopeType: 'direct', scopeId: 'talk-coach', messageId: posted.id, text: 'private', expectedRevision: 1 });
  assert.equal(direct.details?.domainCode, 'YOUTH_POLICY');
});

test('staff tombstones remove searchable text and staff notes never enter search or delivery', async () => {
  const posted = await call('talk-staff', 'postConversationMessage', { requestId: 'tombstone-search', ...team, text: 'Quicksilver snack reminder' });
  const before = await call('talk-guardian', 'searchConversationMessages', { ...team, text: 'quicksilver' });
  assert.equal(before.items.some(item => item.id === posted.id), true);
  await call('talk-staff', 'moderateConversationMessage', { requestId: 'tombstone-search-hide', ...team, messageId: posted.id, reason: 'cleanup' });
  const after = await call('talk-self', 'searchConversationMessages', { ...team, text: 'quicksilver' });
  assert.equal(after.items.some(item => item.id === posted.id), false);
  assert.equal((await db.doc(`organizations/talk-org/messageSearch/${posted.id}`).get()).exists, false);
  const page = await call('talk-self', 'listConversationMessages', { ...team, pageSize: 25 });
  const hidden = page.items.find(item => item.id === posted.id);
  assert.equal(hidden.tombstoned, true);
  assert.equal(hidden.sequence > 0, true);
  assert.equal(JSON.stringify(page).includes('Quicksilver'), false);
  const note = await call('talk-staff', 'postStaffNote', { requestId: 'search-note', ...team, text: 'Orchid passphrase stays private' });
  assert.ok(note.id);
  const searched = await call('talk-admin', 'searchConversationMessages', { ...team, text: 'orchid' });
  assert.equal(JSON.stringify(searched).includes('Orchid'), false);
  assert.equal(JSON.stringify(searched).includes('passphrase'), false);
  const indexed = await db.collection('organizations/talk-org/messageSearch').get();
  assert.equal(indexed.docs.some(doc => JSON.stringify(doc.data()).includes('orchid')), false);
  assert.equal((await db.collection('users/talk-guardian/notifications').get()).size, 0);
  assert.equal((await db.collection('organizations/talk-org/outbox').get()).size, 0);
});

test('reactions toggle for people who can post and follow the message revision', async () => {
  const posted = await call('talk-coach', 'postConversationMessage', { requestId: 'react-source', ...team, text: 'Reaction lantern check' });
  await db.doc('organizations/talk-org').update({ 'policies.youthChannels': 'closed' });
  const closed = await fail('talk-guardian', 'reactToConversationMessage', { requestId: 'guardian-react-closed', ...team, messageId: posted.id, emoji: '👍', expectedRevision: 0 });
  assert.equal(closed.details?.domainCode, 'YOUTH_POLICY');
  await db.doc('organizations/talk-org').update({ 'policies.youthChannels': 'approved' });
  const added = await call('talk-guardian', 'reactToConversationMessage', { requestId: 'guardian-react', ...team, messageId: posted.id, emoji: '👍', expectedRevision: 0 });
  assert.equal(added.active, true);
  assert.equal(added.count, 1);
  const replay = await call('talk-guardian', 'reactToConversationMessage', { requestId: 'guardian-react', ...team, messageId: posted.id, emoji: '👍', expectedRevision: 0 });
  assert.deepEqual(replay, added);
  const coach = await call('talk-coach', 'reactToConversationMessage', { requestId: 'coach-react', ...team, messageId: posted.id, emoji: '👍', expectedRevision: 0 });
  assert.equal(coach.count, 2);
  const page = await call('talk-guardian', 'listConversationMessages', { ...team, pageSize: 10 });
  const row = page.items.find(item => item.id === posted.id);
  assert.equal(row.reactions.find(item => item.emoji === '👍').count, 2);
  assert.equal(row.reactions.find(item => item.emoji === '👍').mine, true);
  const removed = await call('talk-guardian', 'reactToConversationMessage', { requestId: 'guardian-react-off', ...team, messageId: posted.id, emoji: '👍', expectedRevision: 0 });
  assert.equal(removed.active, false);
  const invalidEmoji = await fail('talk-coach', 'reactToConversationMessage', { requestId: 'rocket', ...team, messageId: posted.id, emoji: '🚀', expectedRevision: 0 });
  assert.equal(invalidEmoji.code, 'functions/invalid-argument');
  await call('talk-staff', 'moderateConversationMessage', { requestId: 'react-hide', ...team, messageId: posted.id, reason: 'done' });
  const hidden = await fail('talk-coach', 'reactToConversationMessage', { requestId: 'react-hidden', ...team, messageId: posted.id, emoji: '👍', expectedRevision: 1 });
  assert.equal(hidden.code, 'functions/failed-precondition');
});

test('search denies a revoked audience and continues truthfully past 1000 candidates', async () => {
  const posted = await call('talk-staff', 'postConversationMessage', { requestId: 'range-source', ...team, text: 'Calendarword evening plan' });
  const outside = await call('talk-guardian', 'searchConversationMessages', { ...team, text: 'calendarword', from: '2099-01-01T00:00:00.000Z', to: '2099-01-02T00:00:00.000Z' });
  assert.equal(outside.items.length, 0);
  assert.equal(outside.partial, false);
  const inside = await call('talk-guardian', 'searchConversationMessages', { ...team, text: 'calendarword', from: '2020-01-01T00:00:00.000Z', to: '2099-01-02T00:00:00.000Z' });
  assert.equal(inside.items.some(item => item.id === posted.id), true);
  const tooMany = await fail('talk-guardian', 'searchConversationMessages', { ...team, text: 'one two three four five six' });
  assert.equal(tooMany.code, 'functions/invalid-argument');
  await db.doc('organizations/talk-org/participants/talk-child/guardians/talk-guardian').update({ status: 'revoked' });
  const revoked = await fail('talk-guardian', 'searchConversationMessages', { ...team, text: 'calendarword' });
  assert.equal(revoked.code, 'functions/permission-denied');
  assert.equal(revoked.data, undefined);
  await db.doc('organizations/talk-org/participants/talk-child/guardians/talk-guardian').update({ status: 'active' });

  const { fingerprint } = require('./lib/operations/requests.js');
  const conversationId = fingerprint({ kind: 'conversation', orgId: 'talk-org', scopeType: 'team', scopeId: 'talk-team', channel: 'household' });
  let batch = db.batch();
  let writes = 0;
  const commit = async () => { if (writes) { await batch.commit(); batch = db.batch(); writes = 0; } };
  for (let index = 0; index < 1000; index += 1) {
    const id = `bulk-${String(index).padStart(4, '0')}`;
    batch.set(db.doc(`organizations/talk-org/messageSearch/${id}`), {
      schemaVersion: 2, orgId: 'talk-org', conversationId, tokens: ['bulkword'], revision: 4,
      createdAt: Timestamp.fromMillis(Date.parse('2030-01-01T00:00:00.000Z') + (1000 - index) * 1000), sequence: 5000 + index,
    });
    writes += 1;
    if (writes === 400) await commit();
  }
  const hidden = db.doc(`organizations/talk-org/conversations/${conversationId}/messages/bulk-match`);
  batch.set(hidden, {
    schemaVersion: 2, orgId: 'talk-org', conversationId, authorUid: 'talk-staff', sequence: 9, body: 'bulkword hidden past the cap', tombstoned: false, revision: 0,
    createdAt: Timestamp.fromMillis(Date.parse('2024-01-01T00:00:00.000Z')),
  });
  batch.set(db.doc('organizations/talk-org/messageSearch/bulk-match'), {
    schemaVersion: 2, orgId: 'talk-org', conversationId, tokens: ['bulkword'], revision: 0,
    createdAt: Timestamp.fromMillis(Date.parse('2024-01-01T00:00:00.000Z')), sequence: 9,
  });
  writes += 2;
  await commit();
  const first = await call('talk-admin', 'searchConversationMessages', { ...team, text: 'bulkword' });
  assert.equal(first.partial, true);
  assert.equal(first.items.some(item => item.id === 'bulk-match'), false);
  assert.equal(typeof first.nextCursor, 'string');
  const second = await call('talk-admin', 'searchConversationMessages', { ...team, text: 'bulkword', cursor: first.nextCursor });
  assert.equal(second.items.some(item => item.id === 'bulk-match' && item.body === 'bulkword hidden past the cap'), true);
  assert.equal(second.partial, false);
  const mismatched = await fail('talk-admin', 'searchConversationMessages', { ...team, text: 'calendarword', cursor: first.nextCursor });
  assert.equal(mismatched.code, 'functions/invalid-argument');
  assert.equal(first.nextCursor.length <= 128, true);
  const previousKey = 'demo-search-cursor-previous-key-v1-do-not-use-live';
  const binding = ['talk-admin', conversationId, 'bulkword', '', ''].join('\u001e');
  const resigned = resignSearchCursor(first.nextCursor, 1, previousKey, binding);
  const withPreviousKey = await call('talk-admin', 'searchConversationMessages', { ...team, text: 'bulkword', cursor: resigned });
  assert.equal(withPreviousKey.items.some(item => item.id === 'bulk-match'), true);
  const forged = `${first.nextCursor.slice(0, -1)}${first.nextCursor.endsWith('A') ? 'B' : 'A'}`;
  const tampered = await fail('talk-admin', 'searchConversationMessages', { ...team, text: 'bulkword', cursor: forged });
  assert.equal(tampered.code, 'functions/invalid-argument');
  const peppered = resignSearchCursor(first.nextCursor, 1, 'team-hangout-conversation-search-cursor-v1', binding);
  const publicPepper = await fail('talk-admin', 'searchConversationMessages', { ...team, text: 'bulkword', cursor: peppered });
  assert.equal(publicPepper.code, 'functions/invalid-argument');

  let exactBatch = db.batch();
  let exactWrites = 0;
  const commitExact = async () => { if (exactWrites) { await exactBatch.commit(); exactBatch = db.batch(); exactWrites = 0; } };
  for (let index = 0; index < 1000; index += 1) {
    const id = `cap-${String(index).padStart(4, '0')}`;
    exactBatch.set(db.doc(`organizations/talk-org/messageSearch/${id}`), {
      schemaVersion: 2, orgId: 'talk-org', conversationId, tokens: ['exactcapword'], revision: 4,
      createdAt: Timestamp.fromMillis(Date.parse('2031-01-01T00:00:00.000Z') + (1000 - index) * 1000), sequence: 900000 + index,
    });
    exactWrites += 1;
    if (exactWrites === 400) await commitExact();
  }
  await commitExact();
  const exact = await call('talk-admin', 'searchConversationMessages', { ...team, text: 'exactcapword' });
  assert.equal(exact.partial, false);
  assert.equal(exact.nextCursor, null);
});

test('an exact page does not invent an empty continuation', async () => {
  const { fingerprint } = require('./lib/operations/requests.js');
  const conversationId = fingerprint({ kind: 'conversation', orgId: 'talk-org', scopeType: 'team', scopeId: 'talk-team', channel: 'household' });
  const batch = db.batch();
  for (let index = 0; index < 50; index += 1) {
    const id = `fifty-${String(index).padStart(2, '0')}`;
    const createdAt = Timestamp.fromMillis(Date.parse('2027-06-01T00:00:00.000Z') + index * 1000);
    batch.set(db.doc(`organizations/talk-org/conversations/${conversationId}/messages/${id}`), {
      schemaVersion: 2, orgId: 'talk-org', conversationId, authorUid: 'talk-staff', sequence: 30000 + index,
      body: `fiftyword sample ${index}`, tombstoned: false, revision: 0, createdAt,
    });
    batch.set(db.doc(`organizations/talk-org/messageSearch/${id}`), {
      schemaVersion: 2, orgId: 'talk-org', conversationId, tokens: ['fiftyword', 'sample'], revision: 0, createdAt, sequence: 30000 + index,
    });
  }
  await batch.commit();
  const page = await call('talk-admin', 'searchConversationMessages', { ...team, text: 'fiftyword' });
  assert.equal(page.items.length, 50);
  assert.equal(page.partial, false);
  assert.equal(page.nextCursor, null);
});

test('search backfills messages that predate the token index', async () => {
  const { fingerprint } = require('./lib/operations/requests.js');
  const conversationId = fingerprint({ kind: 'conversation', orgId: 'talk-org', scopeType: 'team', scopeId: 'talk-team', channel: 'household' });
  const conversationRef = db.doc(`organizations/talk-org/conversations/${conversationId}`);
  const conversation = await conversationRef.get();
  const base = conversation.data().sequence;
  await conversationRef.update({ searchIndexComplete: false, searchIndexCursor: null });
  const batch = db.batch();
  const hidden = db.doc(`organizations/talk-org/conversations/${conversationId}/messages/legacy-target`);
  batch.set(hidden, {
    schemaVersion: 2, orgId: 'talk-org', conversationId, authorUid: 'talk-staff', sequence: base + 1,
    body: 'legacyglyph history', tombstoned: false, revision: 3,
    createdAt: Timestamp.fromMillis(Date.parse('2022-01-01T00:00:00.000Z')),
  });
  batch.set(db.doc(`organizations/talk-org/conversations/${conversationId}/messages/legacy-removed`), {
    schemaVersion: 2, orgId: 'talk-org', conversationId, authorUid: 'talk-staff', sequence: base + 102,
    body: null, tombstoned: true, revision: 2,
    createdAt: Timestamp.fromMillis(Date.parse('2022-02-01T00:00:00.000Z')),
  });
  batch.set(db.doc('organizations/talk-org/messageSearch/legacy-removed'), {
    schemaVersion: 2, orgId: 'talk-org', conversationId, tokens: ['legacyglyph'], revision: 2,
    createdAt: Timestamp.fromMillis(Date.parse('2022-02-01T00:00:00.000Z')), sequence: base + 102,
  });
  for (let index = 0; index < 100; index += 1) {
    const id = `legacy-pad-${String(index).padStart(3, '0')}`;
    batch.set(db.doc(`organizations/talk-org/conversations/${conversationId}/messages/${id}`), {
      schemaVersion: 2, orgId: 'talk-org', conversationId, authorUid: 'talk-staff', sequence: base + 2 + index,
      body: 'ordinary practice note', tombstoned: false, revision: 0,
      createdAt: Timestamp.fromMillis(Date.parse('2023-01-01T00:00:00.000Z') + index * 1000),
    });
  }
  await batch.commit();
  const first = await call('talk-admin', 'searchConversationMessages', { ...team, text: 'legacyglyph' });
  assert.equal(first.items.some(item => item.id === 'legacy-target'), false);
  assert.equal(first.partial, true);
  assert.equal(typeof first.nextCursor, 'string');
  const removed = await db.doc('organizations/talk-org/messageSearch/legacy-removed').get();
  assert.equal(removed.exists, false);
  const second = await call('talk-admin', 'searchConversationMessages', { ...team, text: 'legacyglyph', cursor: first.nextCursor });
  assert.equal(second.items.some(item => item.id === 'legacy-target' && item.body === 'legacyglyph history'), true);
  assert.equal(second.partial, false);
  const indexed = await db.doc('organizations/talk-org/messageSearch/legacy-target').get();
  assert.equal(indexed.exists, true);
  assert.deepEqual(indexed.data().tokens, ['legacyglyph', 'history']);
  assert.equal(indexed.data().revision, 3);
});

test('an unfinished backfill restarts continuation so a later index row is not skipped', async () => {
  const { fingerprint } = require('./lib/operations/requests.js');
  const conversationId = fingerprint({ kind: 'conversation', orgId: 'talk-org', scopeType: 'team', scopeId: 'talk-team', channel: 'household' });
  const conversationRef = db.doc(`organizations/talk-org/conversations/${conversationId}`);
  await conversationRef.update({ searchIndexComplete: false, searchIndexCursor: null });
  const batch = db.batch();
  batch.set(db.doc(`organizations/talk-org/conversations/${conversationId}/messages/restart-target`), {
    schemaVersion: 2, orgId: 'talk-org', conversationId, authorUid: 'talk-staff', sequence: 50050,
    body: 'restartglyph hidden early', tombstoned: false, revision: 1,
    createdAt: Timestamp.fromMillis(Date.parse('2025-01-01T00:00:00.000Z')),
  });
  batch.set(db.doc(`organizations/talk-org/conversations/${conversationId}/messages/restart-anchor`), {
    schemaVersion: 2, orgId: 'talk-org', conversationId, authorUid: 'talk-staff', sequence: 50010,
    body: 'restartglyph already indexed', tombstoned: false, revision: 0,
    createdAt: Timestamp.fromMillis(Date.parse('2020-01-01T00:00:00.000Z')),
  });
  batch.set(db.doc('organizations/talk-org/messageSearch/restart-anchor'), {
    schemaVersion: 2, orgId: 'talk-org', conversationId, tokens: ['restartglyph', 'already', 'indexed'], revision: 0,
    createdAt: Timestamp.fromMillis(Date.parse('2020-01-01T00:00:00.000Z')), sequence: 50010,
  });
  for (let index = 0; index < 101; index += 1) {
    const id = `restart-pad-${String(index).padStart(3, '0')}`;
    batch.set(db.doc(`organizations/talk-org/conversations/${conversationId}/messages/${id}`), {
      schemaVersion: 2, orgId: 'talk-org', conversationId, authorUid: 'talk-staff', sequence: 50100 + index,
      body: 'ordinary practice note', tombstoned: false, revision: 0,
      createdAt: Timestamp.fromMillis(Date.parse('2023-01-01T00:00:00.000Z') + index * 1000),
    });
  }
  await batch.commit();
  const first = await call('talk-admin', 'searchConversationMessages', { ...team, text: 'restartglyph' });
  assert.equal(first.items.some(item => item.id === 'restart-target'), false);
  assert.equal(first.partial, true);
  assert.equal(typeof first.nextCursor, 'string');
  const second = await call('talk-admin', 'searchConversationMessages', { ...team, text: 'restartglyph', cursor: first.nextCursor });
  assert.equal(second.items.some(item => item.id === 'restart-target' && item.body === 'restartglyph hidden early'), true);
});

test('search backfill indexes the current message revision', async () => {
  const { fingerprint } = require('./lib/operations/requests.js');
  const conversationId = fingerprint({ kind: 'conversation', orgId: 'talk-org', scopeType: 'team', scopeId: 'talk-team', channel: 'household' });
  await db.doc(`organizations/talk-org/conversations/${conversationId}`).update({ searchIndexComplete: false, searchIndexCursor: null });
  await db.doc(`organizations/talk-org/conversations/${conversationId}/messages/kept-target`).set({
    schemaVersion: 2, orgId: 'talk-org', conversationId, authorUid: 'talk-staff', sequence: 61000,
    body: 'keptglyph final', tombstoned: false, revision: 6,
    createdAt: Timestamp.fromMillis(Date.parse('2024-05-01T00:00:00.000Z')),
  });
  await db.doc('organizations/talk-org/messageSearch/kept-target').set({
    schemaVersion: 2, orgId: 'talk-org', conversationId, tokens: ['oldglyph'], revision: 1,
    createdAt: Timestamp.fromMillis(Date.parse('2024-05-01T00:00:00.000Z')), sequence: 61000,
  });
  const found = await call('talk-admin', 'searchConversationMessages', { ...team, text: 'keptglyph' });
  const indexed = await db.doc('organizations/talk-org/messageSearch/kept-target').get();
  assert.equal(indexed.data().revision, 6);
  assert.equal(indexed.data().tokens.includes('keptglyph'), true);
  assert.equal(indexed.data().tokens.includes('oldglyph'), false);
  assert.equal(found.items.some(item => item.id === 'kept-target' && item.body === 'keptglyph final'), true);
  const stale = await call('talk-admin', 'searchConversationMessages', { ...team, text: 'oldglyph' });
  assert.equal(stale.items.some(item => item.id === 'kept-target'), false);
});

function resignSearchCursor(token, keyId, key, binding) {
  const bytes = Buffer.from(token, 'base64url');
  const body = Buffer.from(bytes.subarray(0, bytes.length - 16));
  body.writeUInt8(keyId, 1);
  const signature = createHmac('sha256', key).update(binding).update(body).digest().subarray(0, 16);
  return Buffer.concat([body, signature]).toString('base64url');
}
