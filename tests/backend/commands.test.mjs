import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { projectId, requireEmulators } from './fixtures.mjs';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp: initializeAdmin, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getAuth: getAdminAuth } = require('firebase-admin/auth');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
requireEmulators();
let admin, db;
const apps = {};
const password = 'SyntheticPassword123!';
let sequence = 0;
const request = (payload) => ({ requestId: `request-${++sequence}`, ...payload });
const call = async (uid, name, payload) => (await httpsCallable(getFunctions(apps[uid]), name)(payload)).data;
const fields = { type: 'practice', title: 'Practice', date: '2026-10-11T00:00:00.000Z', time: '18:00', location: { name: 'Synthetic field' }, notes: null };
before(async () => {
  admin = initializeAdmin({ projectId }); db = getFirestore(admin);
  for (const uid of ['owner', 'player', 'outsider', 'support', 'anonymous']) {
    const app = initializeApp({ projectId, apiKey: 'demo-key' }, `commands-${uid}`); apps[uid] = app;
    connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), '127.0.0.1', 5001);
    if (uid === 'anonymous') continue;
    await getAdminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password });
    await db.doc(`users/${uid}`).set({ uid, displayName: `Synthetic ${uid}`, appRole: uid === 'support' ? 'superAdmin' : 'user' });
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, password);
  }
});
after(async () => { await Promise.all(Object.values(apps).map(deleteApp)); await deleteAdmin(admin); });
async function createTeam() { return call('owner', 'createTeam', request({ name: 'Synthetic Tigers', sport: 'soccer' })); }
async function createEvent(teamId) { return call('owner', 'createEvent', request({ teamId, event: fields })); }
test('every command rejects unauthenticated callers and forged actor/authority fields', async () => {
  for (const name of ['createTeam', 'joinTeamWithInvite', 'regenerateInvite', 'renameTeam', 'createEvent', 'updateEvent', 'softDeleteEvent']) {
    await assert.rejects(call('anonymous', name, {}), { code: 'functions/unauthenticated' });
  }
  await assert.rejects(call('owner', 'createTeam', request({ name: 'Bad', createdBy: 'outsider' })), { code: 'functions/invalid-argument' });
  await assert.rejects(call('owner', 'joinTeamWithInvite', request({ code: 'AAAAAAAA', role: 'coach' })), { code: 'functions/invalid-argument' });
});
test('team creation is atomic and concurrent retries return one canonical coach/team/invite', async () => {
  const payload = request({ name: '  Synthetic Tigers  ', sport: null });
  const [a, b] = await Promise.all([call('owner', 'createTeam', payload), call('owner', 'createTeam', payload)]);
  assert.deepEqual(a, b); assert.equal(a.team.createdBy, 'owner'); assert.equal(a.team.name, 'Synthetic Tigers');
  assert.equal(a.membership.role, 'coach'); assert.equal(a.membership.displayName, 'Synthetic owner');
  assert.equal((await db.doc(`inviteCodes/${a.team.inviteCode}`).get()).data().teamId, a.team.id);
  assert.equal((await db.doc('users/owner').get()).data().activeTeamId, a.team.id);
  assert.equal((await db.doc(`teamMembers/${a.team.id}_owner`).get()).data().userId, 'owner');
  await assert.rejects(call('owner', 'createTeam', { ...payload, name: 'Different' }), error => error.details.domainCode === 'REQUEST_ID_REUSED');
});
test('join accepts only active code, preserves existing roles, and rotation invalidates previous code', async () => {
  const { team } = await createTeam();
  const payload = request({ code: team.inviteCode.toLowerCase() });
  const [a, b] = await Promise.all([call('player', 'joinTeamWithInvite', payload), call('player', 'joinTeamWithInvite', payload)]);
  assert.deepEqual(a, b); assert.equal(a.membership.role, 'player'); assert.equal(a.membership.userId, 'player');
  const owner = await call('owner', 'joinTeamWithInvite', request({ code: team.inviteCode }));
  assert.equal(owner.membership.role, 'coach');
  await assert.rejects(call('player', 'regenerateInvite', request({ teamId: team.id })), { code: 'functions/permission-denied' });
  await assert.rejects(call('outsider', 'regenerateInvite', request({ teamId: team.id, isSuperAdmin: true })), { code: 'functions/invalid-argument' });
  const rotate = request({ teamId: team.id });
  const rotated = await call('owner', 'regenerateInvite', rotate);
  assert.deepEqual(await call('owner', 'regenerateInvite', rotate), rotated);
  assert.equal((await db.doc(`inviteCodes/${team.inviteCode}`).get()).exists, false);
  await assert.rejects(call('outsider', 'joinTeamWithInvite', request({ code: team.inviteCode })), { code: 'functions/not-found' });
  assert.equal((await call('outsider', 'joinTeamWithInvite', request({ code: rotated.inviteCode }))).membership.role, 'player');
  await db.doc(`teamMembers/${team.id}_player`).delete();
  await assert.rejects(call('player', 'joinTeamWithInvite', payload), { code: 'functions/permission-denied' });
});
test('event commands enforce canonical coach, immutable references, validation and revisions', async () => {
  const { team } = await createTeam();
  for (const uid of ['player', 'outsider']) {
    await assert.rejects(call(uid, 'createEvent', request({ teamId: team.id, event: fields })), { code: 'functions/permission-denied' });
  }
  for (const patch of [{ title: '' }, { type: 'other' }, { date: '2026-02-30T00:00:00.000Z' }, { time: '24:00' }, { location: { address: 'Missing name' } }, { notes: 45 }, { createdBy: 'outsider' }]) {
    await assert.rejects(call('owner', 'createEvent', request({ teamId: team.id, event: { ...fields, ...patch } })), { code: 'functions/invalid-argument' });
  }
  const payload = request({ teamId: team.id, event: fields });
  const event = await call('owner', 'createEvent', payload);
  assert.deepEqual(await call('owner', 'createEvent', payload), event);
  assert.equal(event.revision, 1); assert.equal(event.createdBy, 'owner');
  for (const patch of [{ teamId: 'another' }, { orgId: 'forged' }, { createdBy: 'outsider' }]) {
    await assert.rejects(call('owner', 'updateEvent', request({ eventId: event.id, expectedRevision: 1, patch })), { code: 'functions/invalid-argument' });
  }
  const edit = request({ eventId: event.id, expectedRevision: 1, patch: { title: 'Edited' } });
  const edited = await call('owner', 'updateEvent', edit); assert.equal(edited.revision, 2);
  assert.deepEqual(await call('owner', 'updateEvent', edit), edited);
  await assert.rejects(call('owner', 'updateEvent', request({ eventId: event.id, expectedRevision: 1, patch: { title: 'Stale' } })), e => e.code === 'functions/aborted' && e.details.domainCode === 'STALE_REVISION');
  await assert.rejects(call('outsider', 'softDeleteEvent', request({ eventId: event.id, expectedRevision: 2 })), { code: 'functions/permission-denied' });
  const del = request({ eventId: event.id, expectedRevision: 2 });
  assert.equal((await call('owner', 'softDeleteEvent', del)).revision, 3);
  assert.equal((await call('owner', 'softDeleteEvent', del)).revision, 3);
  const stored = (await db.doc(`events/${event.id}`).get()).data();
  assert.equal(stored.teamId, team.id); assert.equal(stored.createdBy, 'owner'); assert.ok(stored.deletedAt instanceof Timestamp);
});
test('concurrent edits admit one winner, legacy revision zero works and support remains authorized', async () => {
  const { team } = await createTeam();
  await db.doc('events/legacy-command').set({ ...fields, date: Timestamp.now(), teamId: team.id, createdBy: 'owner', deletedAt: null });
  const outcomes = await Promise.allSettled(['A', 'B'].map(title => call('owner', 'updateEvent', request({ eventId: 'legacy-command', expectedRevision: 0, patch: { title } }))));
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(x => x.status === 'rejected').reason.details.domainCode, 'STALE_REVISION');
  assert.ok((await call('support', 'regenerateInvite', request({ teamId: team.id }))).inviteCode);
  await call('support', 'renameTeam', request({ teamId: team.id, name: 'Support rename' }));
  assert.equal((await db.doc(`teams/${team.id}`).get()).data().name, 'Support rename');
  const supported = await call('support', 'createEvent', request({ teamId: team.id, event: fields }));
  assert.equal(supported.createdBy, 'support');
  await db.doc(`teamMembers/${team.id}_owner`).delete();
  await assert.rejects(call('owner', 'updateEvent', request({ eventId: 'legacy-command', expectedRevision: 1, patch: { title: 'Revoked' } })), { code: 'functions/permission-denied' });
});
test('organization-v2 writes are gated until hierarchy authorization exists', async () => {
  const { team } = await createTeam();
  await db.doc(`teams/${team.id}`).update({ orgId: 'org-a', schemaVersion: 2 });
  await assert.rejects(call('owner', 'createEvent', request({ teamId: team.id, event: fields })), { code: 'functions/failed-precondition' });
  await assert.rejects(call('support', 'regenerateInvite', request({ teamId: team.id })), { code: 'functions/failed-precondition' });
});
