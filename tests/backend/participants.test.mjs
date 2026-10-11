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
let admin, db, a, b;
const apps = {}; let sequence = 0;
const req = payload => ({ requestId: `house-request-${++sequence}`, ...payload });
const call = async (uid, name, data = {}) => (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const deny = promise => assert.rejects(promise, { code: 'functions/permission-denied' });
async function entity(orgId, kind, fields, uid = 'house-owner', extra = {}) {
  return (await call(uid, 'saveHierarchyEntity', req({ orgId, kind, fields, expectedRevision: 0, ...extra }))).entity;
}
async function fixture(name) {
  const { organization } = await call('house-owner', 'createOrganization', req({ name, kind: 'club', timeZone: 'America/Chicago' }));
  const orgId = organization.id;
  const program = await entity(orgId, 'program', { name: 'Soccer', sportCode: 'soccer', status: 'active' });
  const season = await entity(orgId, 'season', { name: 'Fall', programId: program.id, startsOn: '2026-09-01', endsOn: '2026-12-01', status: 'active' });
  const division = await entity(orgId, 'division', { name: 'U12', programId: program.id, seasonId: season.id, status: 'active' });
  const teamFields = { name: 'Synthetic team', programId: program.id, seasonId: season.id, divisionId: division.id, status: 'active' };
  const { team } = await call('house-owner', 'saveTeam', req({ orgId, expectedRevision: 0, fields: teamFields }));
  return { orgId, organization, program, season, division, team, teamFields };
}
before(async () => {
  admin = adminApp({ projectId }); db = getFirestore(admin);
  for (const uid of ['house-owner', 'house-staff', 'house-outsider', 'house-support', 'house-coach', 'house-parent1', 'house-parent2', 'house-adult', 'house-anonymous']) {
    const app = initializeApp({ projectId, apiKey: 'demo-key' }, uid); apps[uid] = app;
    connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), '127.0.0.1', 5001);
    if (uid === 'house-anonymous') continue;
    await adminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password: 'SyntheticPassword123!' });
    await db.doc(`users/${uid}`).set({ uid, appRole: uid === 'house-support' ? 'superAdmin' : 'user' });
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, 'SyntheticPassword123!');
  }
  await db.doc('organizationOwners/house-owner').set({ enabled: true });
  a = await fixture('Household A'); b = await fixture('Household B');
  for (const f of [a, b]) await db.doc(`organizations/${f.orgId}`).update({ 'features.households': true });
  await call('house-owner', 'setStaffAssignment', req({ orgId: a.orgId, userId: 'house-staff', roles: ['programStaff'], programIds: [a.program.id], status: 'active', expectedRevision: 0 }));
  await db.doc(`teamMembers/${a.team.id}_house-coach`).set({ orgId: a.orgId, teamId: a.team.id, userId: 'house-coach', roles: ['coach'], status: 'active', schemaVersion: 2 });
});
after(async () => { await Promise.all(Object.values(apps).map(deleteApp)); await deleteAdmin(admin); });
const path = (pid, orgId = a.orgId) => `organizations/${orgId}/participants/${pid}`;
const row = async (pid, orgId = a.orgId) => (await db.doc(path(pid, orgId)).get()).data();
async function create(kind = 'youth', orgId = a.orgId, displayName = 'Same synthetic name') {
  return (await call('house-owner', 'saveParticipant', req({ orgId, expectedRevision: 0, fields: { displayName, kind, status: 'active' } }))).participant;
}
async function guardian(pid, userId, operation = 'approveGuardian', extra = {}) {
  return call('house-owner', operation, req({ orgId: a.orgId, participantId: pid, userId, expectedRevision: extra.expectedRevision ?? (await row(pid)).revision, ...extra }));
}
async function enroll(pid, extra = {}, uid = 'house-owner') {
  return call(uid, 'setRosterEnrollment', req({ orgId: a.orgId, participantId: pid, teamId: a.team.id, status: 'active', expectedRevision: 0, ...extra }));
}
const profile = (uid, pid, extra = {}) => call(uid, 'getParticipantProfile', { orgId: a.orgId, participantId: pid, ...extra });
const own = uid => call(uid, 'listMyParticipants');
const permissions = { viewSchedule: true, viewProfile: true, editProfile: false, respond: false };

test('participant endpoints require authentication and reject direct client authority/private reads', async () => {
  for (const name of ['saveParticipant', 'saveParticipantPrivateProfile', 'approveSelfLink', 'approveGuardian', 'revokeGuardian', 'setRosterEnrollment', 'getParticipantProfile', 'editParticipantProfile', 'listMyParticipants', 'listRoster']) {
    await assert.rejects(call('house-anonymous', name), { code: 'functions/unauthenticated' });
  }
  const { initializeTestEnvironment, assertFails } = await import('@firebase/rules-unit-testing');
  const { readFileSync } = await import('node:fs');
  const { doc, setDoc, getDoc } = await import('firebase/firestore');
  const env = await initializeTestEnvironment({ projectId, firestore: { host: '127.0.0.1', port: 8080, rules: readFileSync('firestore.rules', 'utf8') } });
  try {
    const p = await create(); await guardian(p.id, 'house-parent1');
    for (const uid of ['house-parent1', 'house-owner', 'house-support']) {
      const client = env.authenticatedContext(uid).firestore();
      for (const target of [path(p.id), `${path(p.id)}/private/profile`, `${path(p.id)}/guardians/house-parent1`, `teams/${a.team.id}/roster/${p.id}`, `users/house-parent1/participantLinks/${a.orgId}_${p.id}`, `users/house-parent1/teamAccess/${a.team.id}`]) {
        await assertFails(getDoc(doc(client, target))); await assertFails(setDoc(doc(client, target), { status: 'active' }));
      }
    }
  } finally { await env.cleanup(); }
});
test('independent same-name children and two guardians have separate canonical identities and sanitized profiles', async () => {
  const left = await create(); const right = await create(); assert.notEqual(left.id, right.id);
  await enroll(left.id); await enroll(right.id);
  await call('house-owner', 'saveParticipantPrivateProfile', req({ orgId: a.orgId, participantId: left.id, expectedRevision: 0,
    fields: { birthDate: '2016-02-29', contactEmail: 'participant@example.test', guardianContactDetails: 'Private guardian details', operationalNotes: 'Staff only' } }));
  for (const uid of ['house-parent1', 'house-parent2']) await guardian(left.id, uid);
  await guardian(right.id, 'house-parent1');
  for (const uid of ['house-parent1', 'house-parent2']) {
    const result = await profile(uid, left.id); assert.equal(result.profile.birthDate, '2016-02-29');
    assert.equal(result.profile.operationalNotes, undefined); assert.equal(result.profile.guardianContactDetails, undefined);
    await deny(profile(uid, left.id, { staffPrivate: true }));
  }
  assert.equal((await profile('house-owner', left.id, { staffPrivate: true })).profile.operationalNotes, 'Staff only');
  await deny(profile('house-parent2', right.id));
  await deny(profile('house-outsider', left.id)); await deny(profile('house-support', left.id, { staffPrivate: true }));
  const roster = await call('house-coach', 'listRoster', { orgId: a.orgId, teamId: a.team.id });
  assert.ok(roster.items.some(item => item.participantId === left.id));
  for (const item of roster.items) assert.deepEqual(Object.keys(item).sort(), ['displayName', 'jerseyNumber', 'participantId', 'revision', 'status']);
  await deny(profile('house-coach', left.id, { staffPrivate: true }));
  const pointer = (await db.doc(`users/house-parent1/teamAccess/${a.team.id}`).get()).data();
  assert.ok(pointer.sourceParticipantIds.includes(`${a.orgId}_${left.id}`)); assert.ok(pointer.sourceParticipantIds.includes(`${a.orgId}_${right.id}`));
  await guardian(left.id, 'house-parent1', 'revokeGuardian'); await deny(profile('house-parent1', left.id));
  assert.equal((await profile('house-parent2', left.id)).participant.id, left.id);
  assert.equal((await profile('house-parent1', right.id)).participant.id, right.id);
  const after = (await db.doc(`users/house-parent1/teamAccess/${a.team.id}`).get()).data();
  assert.ok(!after.sourceParticipantIds.includes(`${a.orgId}_${left.id}`)); assert.ok(after.sourceParticipantIds.includes(`${a.orgId}_${right.id}`));
  // Deliberately reinsert stale discovery data. It cannot restore a canonical read.
  await db.doc(`users/house-parent1/participantLinks/${a.orgId}_${left.id}`).set({ orgId: a.orgId, participantId: left.id, status: 'active' });
  assert.ok(!(await own('house-parent1')).items.some(item => item.id === left.id));
});
test('only org admin approves identities and grants; foreign references and forged fields fail', async () => {
  const p = await create(); const foreign = await create('youth', b.orgId);
  for (const uid of ['house-outsider', 'house-parent1', 'house-staff', 'house-coach', 'house-support']) {
    await deny(call(uid, 'saveParticipant', req({ orgId: a.orgId, expectedRevision: 0, fields: { displayName: 'Bad', kind: 'youth', status: 'active' } })));
    await deny(call(uid, 'approveGuardian', req({ orgId: a.orgId, participantId: p.id, userId: uid, expectedRevision: 1 })));
    await deny(call(uid, 'approveSelfLink', req({ orgId: a.orgId, participantId: p.id, userId: uid, expectedRevision: 1 })));
    await deny(profile(uid, p.id, { staffPrivate: true }));
  }
  await deny(enroll(foreign.id)); await deny(enroll(p.id, { teamId: b.team.id }));
  await deny(guardian(foreign.id, 'house-parent1', 'approveGuardian', { expectedRevision: 1 }));
  await deny(call('house-owner', 'approveSelfLink', req({ orgId: a.orgId, participantId: foreign.id, userId: 'house-adult', expectedRevision: 1 })));
  await assert.rejects(call('house-owner', 'saveParticipant', req({ orgId: a.orgId, expectedRevision: 0, fields: { displayName: 'Bad', kind: 'youth', status: 'active', linkedUserId: 'house-outsider' } })), { code: 'functions/invalid-argument' });
  await assert.rejects(guardian(p.id, 'house-parent1', 'approveGuardian', { permissions: { ...permissions, respond: true } }), { code: 'functions/invalid-argument' });
  await assert.rejects(guardian(p.id, 'house-parent1', 'approveGuardian', { permissions: { ...permissions, editProfile: true } }), { code: 'functions/invalid-argument' });
  await assert.rejects(call('house-owner', 'saveParticipantPrivateProfile', req({ orgId: a.orgId, participantId: p.id, expectedRevision: 0, fields: { birthDate: '2026-02-30' } })), { code: 'functions/invalid-argument' });
});
test('self-link requires explicit admin approval for adults; unlink invalidates canonical reads and projections', async () => {
  const p = await create('adult'); const child = await create();
  const approve = req({ orgId: a.orgId, participantId: p.id, userId: 'house-adult', expectedRevision: 1 });
  await deny(call('house-adult', 'approveSelfLink', approve));
  await assert.rejects(call('house-owner', 'approveSelfLink', req({ orgId: a.orgId, participantId: child.id, userId: 'house-adult', expectedRevision: 1 })), { code: 'functions/invalid-argument' });
  await enroll(p.id);
  const request = { ...approve, expectedRevision: (await row(p.id)).revision };
  const saved = await call('house-owner', 'approveSelfLink', request);
  assert.deepEqual(await call('house-owner', 'approveSelfLink', request), saved);
  assert.equal((await profile('house-adult', p.id)).participant.id, p.id);
  assert.ok((await own('house-adult')).items.some(item => item.id === p.id && item.relationship === 'self'));
  assert.ok((await call('house-adult', 'listMyOrganizations')).items.some(item => item.id === a.orgId));
  await call('house-owner', 'approveSelfLink', req({ orgId: a.orgId, participantId: p.id, userId: null, expectedRevision: saved.participant.revision }));
  await deny(profile('house-adult', p.id)); assert.deepEqual((await own('house-adult')).items, []);
  assert.deepEqual((await call('house-adult', 'listMyOrganizations')).items, []);
});
test('roster enrollment scopes program staff, strips private data and atomically updates access metadata', async () => {
  const p = await create(); await guardian(p.id, 'house-parent2'); const before = await row(p.id);
  const saved = await enroll(p.id, {}, 'house-staff');
  assert.equal(saved.accessRevision, before.accessRevision + 1);
  assert.ok((await db.doc(`users/house-parent2/teamAccess/${a.team.id}`).get()).data().sourceParticipantIds.includes(`${a.orgId}_${p.id}`));
  await deny(enroll(p.id, { teamId: b.team.id }, 'house-staff'));
  await deny(call('house-staff', 'listRoster', { orgId: b.orgId, teamId: b.team.id }));
  for (const uid of ['house-parent2', 'house-outsider', 'house-support']) await deny(call(uid, 'listRoster', { orgId: a.orgId, teamId: a.team.id }));
  await enroll(p.id, { status: 'removed', expectedRevision: 1 }, 'house-staff');
  assert.ok(!(await db.doc(`users/house-parent2/teamAccess/${a.team.id}`).get()).data().sourceParticipantIds.includes(`${a.orgId}_${p.id}`));
  assert.equal((await profile('house-parent2', p.id)).participant.id, p.id); // Profile approval is independent of enrollment.
  await assert.rejects(enroll(p.id, { expectedRevision: 1 }), error => error.details.domainCode === 'STALE_REVISION');
});
test('concurrent grants use participant revision and replay never overwrites later revocation', async () => {
  const p = await create();
  const requests = ['house-parent1', 'house-parent2'].map(userId => req({ orgId: a.orgId, participantId: p.id, userId, expectedRevision: 1 }));
  const results = await Promise.allSettled(requests.map(payload => call('house-owner', 'approveGuardian', payload)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.details.domainCode, 'STALE_REVISION');
  const index = results.findIndex(result => result.status === 'fulfilled'); const approved = requests[index];
  await guardian(p.id, approved.userId, 'revokeGuardian');
  assert.deepEqual(await call('house-owner', 'approveGuardian', approved), results[index].value);
  await deny(profile(approved.userId, p.id));
  assert.equal((await db.doc(`${path(p.id)}/guardians/${approved.userId}`).get()).data().status, 'revoked');
  await db.doc(`organizations/${a.orgId}/members/house-owner`).update({ status: 'revoked' });
  await deny(call('house-owner', 'approveGuardian', approved));
  await db.doc(`organizations/${a.orgId}/members/house-owner`).update({ status: 'active' });
});
test('guardian profile edits enforce configured rights, field allowlist, conflicts and immediate permission loss', async () => {
  const p = await create(); await enroll(p.id);
  await guardian(p.id, 'house-parent2');
  const edit = () => call('house-parent2', 'editParticipantProfile', req({ orgId: a.orgId, participantId: p.id, expectedRevision: 0, fields: { contactPhone: '555-0100' } }));
  await deny(edit());
  await db.doc(`organizations/${a.orgId}`).update({ 'features.guardianProfileEditing': true });
  await guardian(p.id, 'house-parent2', 'approveGuardian', { permissions: { ...permissions, editProfile: true } });
  const payload = req({ orgId: a.orgId, participantId: p.id, expectedRevision: 0, fields: { contactPhone: '555-0100' } });
  assert.equal((await call('house-parent2', 'editParticipantProfile', payload)).revision, 1);
  assert.equal((await profile('house-parent2', p.id)).profile.contactPhone, '555-0100');
  await assert.rejects(edit(), error => error.details.domainCode === 'STALE_REVISION');
  await assert.rejects(call('house-parent2', 'editParticipantProfile', req({ orgId: a.orgId, participantId: p.id, expectedRevision: 1, fields: { operationalNotes: 'Forged' } })), { code: 'functions/invalid-argument' });
  await guardian(p.id, 'house-parent2', 'revokeGuardian');
  await deny(call('house-parent2', 'editParticipantProfile', payload));
  await deny(profile('house-parent2', p.id));
});
test('household rollout flag and deleting actors fail closed; archival still permits grant revocation', async () => {
  const p = await create(); await guardian(p.id, 'house-parent1');
  await db.doc(`organizations/${a.orgId}`).update({ 'features.households': false });
  await deny(profile('house-parent1', p.id)); assert.ok(!(await own('house-parent1')).items.some(item => item.id === p.id));
  await db.doc(`organizations/${a.orgId}`).update({ 'features.households': true });
  await db.doc('users/house-parent1').update({ accountState: 'deleting' });
  await deny(profile('house-parent1', p.id)); await deny(own('house-parent1'));
  await assert.rejects(guardian(p.id, 'house-parent1'), { code: 'functions/permission-denied' });
  await db.doc('users/house-parent1').update({ accountState: 'active' });
  await db.doc(`organizations/${a.orgId}`).update({ status: 'archived', 'features.organizationV2': false });
  await guardian(p.id, 'house-parent1', 'revokeGuardian'); await deny(profile('house-parent1', p.id));
  await db.doc(`organizations/${a.orgId}`).update({ status: 'active', 'features.organizationV2': true });
});
test('same-organization program boundary and revoked coach assignments protect roster reads and enrollment', async () => {
  const program = await entity(a.orgId, 'program', { name: 'Other program', sportCode: 'other', status: 'active' });
  const season = await entity(a.orgId, 'season', { name: 'Other season', programId: program.id, startsOn: '2026-01-01', endsOn: '2026-12-31', status: 'active' });
  const division = await entity(a.orgId, 'division', { name: 'Other division', programId: program.id, seasonId: season.id, status: 'active' });
  const { team } = await call('house-owner', 'saveTeam', req({ orgId: a.orgId, expectedRevision: 0, fields: { name: 'Other team', programId: program.id, seasonId: season.id, divisionId: division.id, status: 'active' } }));
  const p = await create();
  await deny(enroll(p.id, { teamId: team.id }, 'house-staff'));
  await deny(call('house-staff', 'listRoster', { orgId: a.orgId, teamId: team.id }));
  const pointer = db.doc(`teamMembers/${a.team.id}_house-coach`); await pointer.update({ status: 'revoked' });
  await deny(call('house-coach', 'listRoster', { orgId: a.orgId, teamId: a.team.id }));
  await pointer.update({ status: 'active' });
});
test('atomic fanout limits refuse grants/enrollments without partial writes', async () => {
  const p = await create(); const root = db.doc(path(p.id)); const batch = db.batch();
  for (let i = 0; i < 10; i++) batch.set(root.collection('guardians').doc(`synthetic-guardian-${i}`), { orgId: a.orgId, participantId: p.id, userId: `synthetic-guardian-${i}`, status: 'active', permissions });
  for (let i = 0; i < 20; i++) batch.set(db.doc(`teams/synthetic-team-${i}/roster/${p.id}`), { orgId: a.orgId, participantId: p.id, status: 'active' });
  await batch.commit();
  await assert.rejects(guardian(p.id, 'house-parent1'), { code: 'functions/resource-exhausted' });
  await assert.rejects(enroll(p.id), { code: 'functions/resource-exhausted' });
  assert.equal((await root.get()).data().revision, 1);
  assert.equal((await root.collection('guardians').doc('house-parent1').get()).exists, false);
  assert.equal((await db.doc(`teams/${a.team.id}/roster/${p.id}`).get()).exists, false);
});
test('pagination, scheduled-only permission and request deduplication stay private', async () => {
  const p = await create();
  const request = req({ orgId: a.orgId, participantId: p.id, userId: 'house-parent1', expectedRevision: 1, permissions: { ...permissions, viewProfile: false } });
  const saved = await call('house-owner', 'approveGuardian', request);
  assert.deepEqual(await call('house-owner', 'approveGuardian', request), saved);
  await assert.rejects(call('house-owner', 'approveGuardian', { ...request, userId: 'house-parent2' }), error => error.details.domainCode === 'REQUEST_ID_REUSED');
  await deny(profile('house-parent1', p.id));
  assert.ok((await own('house-parent1')).items.some(item => item.id === p.id));
  const first = await call('house-parent1', 'listMyParticipants', { pageSize: 1 });
  assert.ok(first.items.length <= 1);
  if (first.nextCursor) {
    const next = await call('house-parent1', 'listMyParticipants', { pageSize: 1, cursor: first.nextCursor });
    assert.ok(!next.items.some(item => first.items.some(previous => previous.id === item.id)));
  }
  for (const pageSize of [0, 51, 1.5]) await assert.rejects(call('house-parent1', 'listMyParticipants', { pageSize }), { code: 'functions/invalid-argument' });
});
test('participant archive/restoration removes and restores only live sources; archived self unlink remains available', async () => {
  const p = await create('adult'); await enroll(p.id); await guardian(p.id, 'house-parent2');
  await call('house-owner', 'approveSelfLink', req({ orgId: a.orgId, participantId: p.id, userId: 'house-adult', expectedRevision: (await row(p.id)).revision }));
  const archive = async status => call('house-owner', 'saveParticipant', req({ orgId: a.orgId, participantId: p.id, expectedRevision: (await row(p.id)).revision,
    fields: { displayName: p.displayName, kind: 'adult', status } }));
  await archive('archived'); await deny(profile('house-parent2', p.id)); await deny(profile('house-adult', p.id));
  assert.ok(!(await db.doc(`users/house-parent2/teamAccess/${a.team.id}`).get()).data().sourceParticipantIds.includes(`${a.orgId}_${p.id}`));
  await archive('active'); assert.equal((await profile('house-parent2', p.id)).participant.id, p.id);
  await db.doc(`organizations/${a.orgId}`).update({ status: 'archived' });
  await call('house-owner', 'approveSelfLink', req({ orgId: a.orgId, participantId: p.id, userId: null, expectedRevision: (await row(p.id)).revision }));
  await deny(profile('house-adult', p.id));
  await enroll(p.id, { status: 'removed', expectedRevision: 1 });
  await db.doc(`organizations/${a.orgId}`).update({ status: 'active' });
});

test('partial contact edits preserve omitted contacts and private fields while explicit null clears only its field', async () => {
  const p = await create();
  await call('house-owner', 'saveParticipantPrivateProfile', req({ orgId: a.orgId, participantId: p.id, expectedRevision: 0,
    fields: { birthDate: '2016-02-29', contactEmail: 'original@example.test', contactPhone: '555-0100', guardianContactDetails: 'Private contact', operationalNotes: 'Staff note' } }));
  await db.doc(`organizations/${a.orgId}`).update({ 'features.guardianProfileEditing': true });
  await guardian(p.id, 'house-parent2', 'approveGuardian', { permissions: { ...permissions, editProfile: true } });
  const ref = db.doc(`${path(p.id)}/private/profile`);
  const original = (await ref.get()).data();
  const phoneEdit = req({ orgId: a.orgId, participantId: p.id, expectedRevision: 1, fields: { contactPhone: '555-0200' } });
  const changes = [
    [phoneEdit, { contactEmail: 'original@example.test', contactPhone: '555-0200' }],
    [req({ orgId: a.orgId, participantId: p.id, expectedRevision: 2, fields: { contactEmail: 'new@example.test' } }), { contactEmail: 'new@example.test', contactPhone: '555-0200' }],
    [req({ orgId: a.orgId, participantId: p.id, expectedRevision: 3, fields: { contactPhone: null } }), { contactEmail: 'new@example.test', contactPhone: null }],
    [req({ orgId: a.orgId, participantId: p.id, expectedRevision: 4, fields: { contactEmail: null } }), { contactEmail: null, contactPhone: null }],
  ];
  for (const [payload, expected] of changes) {
    const saved = await call('house-parent2', 'editParticipantProfile', payload);
    const stored = (await ref.get()).data();
    assert.equal(saved.revision, payload.expectedRevision + 1);
    assert.equal(stored.contactEmail, expected.contactEmail); assert.equal(stored.contactPhone, expected.contactPhone);
    for (const field of ['birthDate', 'guardianContactDetails', 'operationalNotes', 'createdAt', 'createdBy']) assert.deepEqual(stored[field], original[field]);
  }
  const final = (await ref.get()).data();
  assert.equal((await call('house-parent2', 'editParticipantProfile', phoneEdit)).revision, 2);
  assert.deepEqual((await ref.get()).data(), final);
  await assert.rejects(call('house-parent2', 'editParticipantProfile', { ...phoneEdit, fields: { ...phoneEdit.fields, contactEmail: null } }), error => error.details.domainCode === 'REQUEST_ID_REUSED');
});
