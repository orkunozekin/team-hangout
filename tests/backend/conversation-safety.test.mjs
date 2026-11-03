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
const team = { orgId: 'safe-org', scopeType: 'team', scopeId: 'safe-team' };
const announcements = { orgId: 'safe-org', scopeType: 'organization', scopeId: 'safe-org' };
const USERS = ['safe-admin', 'safe-staff', 'safe-other-staff', 'safe-coach', 'safe-guardian', 'safe-parent', 'safe-outsider', 'safe-foreign-admin'];
let seq = 0;
const post = async (uid, scope, text) => call(uid, 'postConversationMessage', { requestId: `safe-post-${++seq}`, ...scope, text });

before(async () => {
  admin = adminApp({ projectId }); db = getFirestore(admin);
  for (const uid of USERS) {
    const app = initializeApp({ projectId, apiKey: 'demo-key' }, uid); apps[uid] = app;
    connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), '127.0.0.1', 5001);
    await adminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password: 'SyntheticPassword123!' });
    await db.doc(`users/${uid}`).set({ uid, email: `${uid}@example.test`, appRole: 'user' });
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, 'SyntheticPassword123!');
  }
  const org = { ...meta, features: { organizationV2: true, households: true, conversations: true }, policies: { youthChannels: 'approved' } };
  await db.doc('organizations/safe-org').set({ ...org, name: 'Synthetic Safety' });
  await db.doc('organizations/foreign-org').set({ ...org, name: 'Synthetic Foreign' });
  await db.doc('organizations/safe-org/members/safe-admin').set({ ...meta, orgId: 'safe-org', userId: 'safe-admin', roles: ['orgAdmin'], programIds: [] });
  await db.doc('organizations/safe-org/members/safe-staff').set({ ...meta, orgId: 'safe-org', userId: 'safe-staff', roles: ['programStaff'], programIds: ['safe-program'] });
  await db.doc('organizations/safe-org/members/safe-other-staff').set({ ...meta, orgId: 'safe-org', userId: 'safe-other-staff', roles: ['programStaff'], programIds: ['other-program'] });
  await db.doc('organizations/foreign-org/members/safe-foreign-admin').set({ ...meta, orgId: 'foreign-org', userId: 'safe-foreign-admin', roles: ['orgAdmin'], programIds: [] });
  await db.doc('teams/safe-team').set({ ...meta, orgId: 'safe-org', programId: 'safe-program', seasonId: 'safe-season', divisionId: 'safe-division', name: 'Owls' });
  await db.doc('teamMembers/safe-team_safe-coach').set({ ...meta, orgId: 'safe-org', teamId: 'safe-team', userId: 'safe-coach', roles: ['coach'] });
  for (const [child, guardian] of [['safe-child-a', 'safe-guardian'], ['safe-child-b', 'safe-parent']]) {
    await db.doc(`organizations/safe-org/participants/${child}`).set({ ...meta, orgId: 'safe-org', displayName: 'Child' });
    await db.doc(`teams/safe-team/roster/${child}`).set({ ...meta, orgId: 'safe-org', participantId: child });
    await db.doc(`organizations/safe-org/participants/${child}/guardians/${guardian}`).set({
      ...meta, orgId: 'safe-org', participantId: child, userId: guardian, permissions: { viewSchedule: true, respond: true }, grantedAt: Timestamp.fromMillis(0),
    });
  }
});
after(async () => { await Promise.all(Object.values(apps).map(app => deleteApp(app))); if (admin) await deleteAdmin(admin); });

test('a participant reports a message once and only org moderators see the reporter', async () => {
  const message = await post('safe-parent', team, 'Reportable rude words');
  const input = { ...team, messageId: message.id, reason: 'harassment', note: 'Unkind to my child' };
  const report = await call('safe-guardian', 'reportConversationMessage', { requestId: 'safe-report-1', ...input });
  assert.equal(report.status, 'open');
  assert.equal(report.duplicate, false);
  const replay = await call('safe-guardian', 'reportConversationMessage', { requestId: 'safe-report-1', ...input });
  assert.equal(replay.id, report.id);
  const again = await call('safe-guardian', 'reportConversationMessage', { requestId: 'safe-report-2', ...input });
  assert.equal(again.duplicate, true);
  assert.equal(again.id, report.id);
  const own = await fail('safe-parent', 'reportConversationMessage', { requestId: 'safe-report-own', ...input });
  assert.equal(own.code, 'functions/invalid-argument');
  const badReason = await fail('safe-guardian', 'reportConversationMessage', { requestId: 'safe-report-bad', ...input, reason: 'dislike' });
  assert.equal(badReason.code, 'functions/invalid-argument');

  const stored = (await db.doc(`organizations/safe-org/conversationReports/${report.id}`).get()).data();
  assert.equal(stored.reporterUid, 'safe-guardian');
  assert.equal(stored.programKey, 'safe-program');
  assert.equal(stored.reportedBody, 'Reportable rude words');
  const channel = await call('safe-coach', 'listConversationMessages', { ...team, pageSize: 50 });
  assert.equal(channel.items.find(row => row.id === message.id).body, 'Reportable rude words', 'a report does not remove content');

  const queue = await call('safe-staff', 'listConversationReports', { orgId: 'safe-org' });
  const row = queue.items.find(item => item.id === report.id);
  assert.equal(row.reporterUid, 'safe-guardian');
  assert.equal(row.reason, 'harassment');
  assert.equal(row.note, 'Unkind to my child');
  assert.equal(row.reportedBody, 'Reportable rude words');
  assert.equal((await call('safe-admin', 'listConversationReports', { orgId: 'safe-org' })).items.some(item => item.id === report.id), true);
  assert.equal((await call('safe-other-staff', 'listConversationReports', { orgId: 'safe-org' })).items.some(item => item.id === report.id), false);
  for (const uid of ['safe-coach', 'safe-guardian', 'safe-parent', 'safe-outsider', 'safe-foreign-admin']) {
    const denied = await fail(uid, 'listConversationReports', { orgId: 'safe-org' });
    assert.equal(denied.code, 'functions/permission-denied', uid);
  }
});

test('moderators dismiss reports or remove the message, and others cannot resolve', async () => {
  const message = await post('safe-parent', team, 'Second questionable message');
  const first = await call('safe-guardian', 'reportConversationMessage', { requestId: 'safe-resolve-1', ...team, messageId: message.id, reason: 'spam' });
  const second = await call('safe-coach', 'reportConversationMessage', { requestId: 'safe-resolve-2', ...team, messageId: message.id, reason: 'inappropriate' });
  for (const uid of ['safe-coach', 'safe-other-staff', 'safe-foreign-admin']) {
    const denied = await fail(uid, 'resolveConversationReport', { requestId: `safe-resolve-deny-${uid}`, orgId: 'safe-org', reportId: first.id, resolution: 'dismissed' });
    assert.equal(denied.code, 'functions/permission-denied', uid);
  }
  const crossOrg = await fail('safe-foreign-admin', 'resolveConversationReport', { requestId: 'safe-resolve-cross', orgId: 'foreign-org', reportId: first.id, resolution: 'dismissed' });
  assert.equal(crossOrg.code, 'functions/permission-denied');
  const early = await fail('safe-staff', 'resolveConversationReport', { requestId: 'safe-resolve-early', orgId: 'safe-org', reportId: first.id, resolution: 'removed' });
  assert.equal(early.details?.domainCode, 'MESSAGE_NOT_REMOVED');
  await call('safe-staff', 'moderateConversationMessage', { requestId: 'safe-resolve-moderate', ...team, messageId: message.id, reason: 'Report reviewed' });
  const resolved = await call('safe-staff', 'resolveConversationReport', { requestId: 'safe-resolve-remove', orgId: 'safe-org', reportId: first.id, resolution: 'removed' });
  assert.equal(resolved.status, 'removed');
  for (const id of [first.id, second.id]) {
    const row = (await db.doc(`organizations/safe-org/conversationReports/${id}`).get()).data();
    assert.equal(row.status, 'removed');
    assert.equal(row.reportedBody, undefined);
  }
  const queue = await call('safe-admin', 'listConversationReports', { orgId: 'safe-org' });
  assert.equal(queue.items.some(item => item.messageId === message.id), false);

  const other = await post('safe-parent', team, 'Harmless but reported');
  const third = await call('safe-guardian', 'reportConversationMessage', { requestId: 'safe-resolve-3', ...team, messageId: other.id, reason: 'other' });
  const dismissed = await call('safe-admin', 'resolveConversationReport', { requestId: 'safe-resolve-dismiss', orgId: 'safe-org', reportId: third.id, resolution: 'dismissed' });
  assert.equal(dismissed.status, 'dismissed');
  const page = await call('safe-guardian', 'listConversationMessages', { ...team, pageSize: 50 });
  assert.equal(page.items.find(row => row.id === other.id).body, 'Harmless but reported');
});

test('blocking hides an author from list and search for the blocker only, and unblocking restores them', async () => {
  const hiddenMessage = await post('safe-parent', team, 'Blockedauthorword from a parent');
  const coachMessage = await post('safe-coach', team, 'Blockedauthorword from the coach');
  const before = await call('safe-guardian', 'listConversationMessages', { ...team, pageSize: 50 });
  assert.equal(before.canBlock, true);
  const blocked = await call('safe-guardian', 'blockConversationMember', { requestId: 'safe-block-1', ...team, messageId: hiddenMessage.id });
  assert.equal(blocked.blocked, true);
  const replay = await call('safe-guardian', 'blockConversationMember', { requestId: 'safe-block-1', ...team, messageId: hiddenMessage.id });
  assert.equal(replay.id, blocked.id);

  const page = await call('safe-guardian', 'listConversationMessages', { ...team, pageSize: 50 });
  assert.equal(page.items.some(row => row.authorUid === 'safe-parent'), false);
  assert.equal(page.items.some(row => row.id === coachMessage.id), true);
  const search = await call('safe-guardian', 'searchConversationMessages', { ...team, text: 'blockedauthorword' });
  assert.deepEqual(search.items.map(row => row.id), [coachMessage.id]);

  for (const uid of ['safe-coach', 'safe-staff', 'safe-admin']) {
    const view = await call(uid, 'listConversationMessages', { ...team, pageSize: 50 });
    assert.equal(view.items.some(row => row.id === hiddenMessage.id), true, `${uid} keeps the moderation view`);
    assert.equal(view.canBlock, false);
  }
  const otherHousehold = await call('safe-parent', 'listConversationMessages', { ...team, pageSize: 50 });
  assert.equal(otherHousehold.items.some(row => row.id === hiddenMessage.id), true);
  const report = await call('safe-guardian', 'reportConversationMessage', { requestId: 'safe-block-report', ...team, messageId: hiddenMessage.id, reason: 'harassment' });
  assert.equal((await call('safe-staff', 'listConversationReports', { orgId: 'safe-org' })).items.some(item => item.id === report.id), true);

  const blocks = await call('safe-guardian', 'listConversationBlocks', { orgId: 'safe-org' });
  assert.deepEqual(blocks.items.map(item => item.id), [blocked.id]);
  assert.equal(JSON.stringify(blocks).includes('safe-parent'), false);
  const stranger = await fail('safe-parent', 'unblockConversationMember', { requestId: 'safe-unblock-other', orgId: 'safe-org', blockId: blocked.id });
  assert.equal(stranger.code, 'functions/permission-denied');
  await call('safe-guardian', 'unblockConversationMember', { requestId: 'safe-unblock', orgId: 'safe-org', blockId: blocked.id });
  const restored = await call('safe-guardian', 'listConversationMessages', { ...team, pageSize: 50 });
  assert.equal(restored.items.some(row => row.id === hiddenMessage.id), true);
});

test('blocked authors who become staff or coaches stay visible, and staff, coaches, and announcements cannot be blocked', async () => {
  const coachMessage = await post('safe-coach', team, 'Coach update');
  const coachBlock = await fail('safe-guardian', 'blockConversationMember', { requestId: 'safe-block-coach', ...team, messageId: coachMessage.id });
  assert.equal(coachBlock.details?.domainCode, 'BLOCK_NOT_ALLOWED');
  const staffMessage = await post('safe-staff', team, 'Staff update');
  const staffBlock = await fail('safe-guardian', 'blockConversationMember', { requestId: 'safe-block-staff', ...team, messageId: staffMessage.id });
  assert.equal(staffBlock.details?.domainCode, 'BLOCK_NOT_ALLOWED');
  const announcement = await post('safe-admin', announcements, 'Season announcement');
  const announcementBlock = await fail('safe-guardian', 'blockConversationMember', { requestId: 'safe-block-announcement', ...announcements, messageId: announcement.id });
  assert.equal(announcementBlock.details?.domainCode, 'BLOCK_NOT_AVAILABLE');
  const parentMessage = await post('safe-parent', team, 'Message before promotion');
  const coachTries = await fail('safe-coach', 'blockConversationMember', { requestId: 'safe-block-by-coach', ...team, messageId: parentMessage.id });
  assert.equal(coachTries.details?.domainCode, 'BLOCK_NOT_AVAILABLE');

  const block = await call('safe-guardian', 'blockConversationMember', { requestId: 'safe-block-promote', ...team, messageId: parentMessage.id });
  assert.equal((await call('safe-guardian', 'listConversationMessages', { ...team, pageSize: 50 })).items.some(row => row.id === parentMessage.id), false);
  await db.doc('teamMembers/safe-team_safe-parent').set({ ...meta, orgId: 'safe-org', teamId: 'safe-team', userId: 'safe-parent', roles: ['coach'] });
  assert.equal((await call('safe-guardian', 'listConversationMessages', { ...team, pageSize: 50 })).items.some(row => row.id === parentMessage.id), true);
  await db.doc('teamMembers/safe-team_safe-parent').delete();
  await call('safe-guardian', 'unblockConversationMember', { requestId: 'safe-unblock-promote', orgId: 'safe-org', blockId: block.id });
});

test('cross-organization callers and revoked guardians cannot report or block', async () => {
  const message = await post('safe-parent', team, 'Cross org target');
  for (const uid of ['safe-outsider', 'safe-foreign-admin']) {
    const report = await fail(uid, 'reportConversationMessage', { requestId: `safe-cross-report-${uid}`, ...team, messageId: message.id, reason: 'spam' });
    assert.equal(report.code, 'functions/permission-denied', uid);
    const block = await fail(uid, 'blockConversationMember', { requestId: `safe-cross-block-${uid}`, ...team, messageId: message.id });
    assert.equal(block.code, 'functions/permission-denied', uid);
  }
  const foreign = await fail('safe-foreign-admin', 'reportConversationMessage', { requestId: 'safe-cross-path', ...team, orgId: 'foreign-org', messageId: message.id, reason: 'spam' });
  assert.equal(foreign.code, 'functions/permission-denied');

  const grant = db.doc('organizations/safe-org/participants/safe-child-a/guardians/safe-guardian');
  const block = await call('safe-guardian', 'blockConversationMember', { requestId: 'safe-revoke-block', ...team, messageId: message.id });
  await grant.update({ status: 'revoked' });
  try {
    const report = await fail('safe-guardian', 'reportConversationMessage', { requestId: 'safe-revoked-report', ...team, messageId: message.id, reason: 'spam' });
    assert.equal(report.code, 'functions/permission-denied');
    const blockReplay = await fail('safe-guardian', 'blockConversationMember', { requestId: 'safe-revoke-block', ...team, messageId: message.id });
    assert.equal(blockReplay.code, 'functions/permission-denied');
    const list = await fail('safe-guardian', 'listConversationMessages', team);
    assert.equal(list.code, 'functions/permission-denied');
    // Unblocking only widens what the person sees once access returns, so it stays available.
    await call('safe-guardian', 'unblockConversationMember', { requestId: 'safe-revoked-unblock', orgId: 'safe-org', blockId: block.id });
  } finally {
    await grant.update({ status: 'active' });
  }
});
