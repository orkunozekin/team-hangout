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
  for (const uid of ['talk-admin', 'talk-staff', 'talk-coach', 'talk-guardian', 'talk-self', 'talk-outsider']) {
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
