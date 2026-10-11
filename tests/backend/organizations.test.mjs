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
let admin, db, a, b, otherProgram;
const apps = {}; let sequence = 0;
const req = payload => ({ requestId: `org-request-${++sequence}`, ...payload });
const call = async (uid, name, data = {}) => (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const deny = promise => assert.rejects(promise, { code: 'functions/permission-denied' });
const fields = { title: 'Synthetic practice', type: 'practice', startsAt: '2026-10-11T23:00:00.000Z', endsAt: '2026-10-12T00:00:00.000Z', timeZone: 'America/Chicago', status: 'scheduled', publicationState: 'staged' };
async function entity(orgId, kind, fields, uid = 'org-owner', extra = {}) {
  return (await call(uid, 'saveHierarchyEntity', req({ orgId, kind, fields, expectedRevision: 0, ...extra }))).entity;
}
async function fixture(name) {
  const { organization } = await call('org-owner', 'createOrganization', req({ name, kind: 'club', timeZone: 'America/Chicago' }));
  const orgId = organization.id;
  const program = await entity(orgId, 'program', { name: 'Soccer', sportCode: 'soccer', status: 'active' });
  const season = await entity(orgId, 'season', { name: 'Fall', programId: program.id, startsOn: '2026-09-01', endsOn: '2026-12-01', status: 'active' });
  const division = await entity(orgId, 'division', { name: 'U12', programId: program.id, seasonId: season.id, status: 'active' });
  const teamFields = { name: 'Synthetic team', programId: program.id, seasonId: season.id, divisionId: division.id, status: 'active' };
  const { team } = await call('org-owner', 'saveTeam', req({ orgId, expectedRevision: 0, fields: teamFields }));
  return { orgId, organization, program, season, division, team, teamFields };
}
async function assign(userId, roles, programIds, status = 'active', expectedRevision = 0) {
  return call('org-owner', 'setStaffAssignment', req({ orgId: a.orgId, userId, roles, programIds, status, expectedRevision }));
}
before(async () => {
  admin = adminApp({ projectId }); db = getFirestore(admin);
  for (const uid of ['org-owner', 'org-staff', 'org-outsider', 'org-support', 'org-coach', 'org-anonymous']) {
    const app = initializeApp({ projectId, apiKey: 'demo-key' }, uid); apps[uid] = app;
    connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), '127.0.0.1', 5001);
    if (uid === 'org-anonymous') continue;
    await adminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password: 'SyntheticPassword123!' });
    await db.doc(`users/${uid}`).set({ uid, appRole: uid === 'org-support' ? 'superAdmin' : 'user' });
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, 'SyntheticPassword123!');
  }
  await db.doc('organizationOwners/org-owner').set({ enabled: true });
  a = await fixture('Synthetic A'); b = await fixture('Synthetic B');
  otherProgram = await entity(a.orgId, 'program', { name: 'Basketball', sportCode: 'basketball', status: 'active' });
  await assign('org-staff', ['programStaff'], [a.program.id]);
  await db.doc(`teamMembers/${a.team.id}_org-coach`).set({ orgId: a.orgId, teamId: a.team.id, userId: 'org-coach', roles: ['coach'], role: 'coach', status: 'active', schemaVersion: 2 });
});
after(async () => { await Promise.all(Object.values(apps).map(deleteApp)); await deleteAdmin(admin); });
test('bootstrap requires server owner grant, creates first admin atomically, and deduplicates', async () => {
  for (const uid of ['org-outsider', 'org-support', 'org-staff']) {
    await deny(call(uid, 'createOrganization', req({ name: 'Forbidden', kind: 'club', timeZone: 'UTC' })));
  }
  const payload = req({ name: 'Retry fixture', kind: 'municipal', timeZone: 'UTC' });
  const [first, second] = await Promise.all([call('org-owner', 'createOrganization', payload), call('org-owner', 'createOrganization', payload)]);
  assert.deepEqual(first, second);
  const orgId = first.organization.id;
  assert.deepEqual((await db.doc(`organizations/${orgId}/members/org-owner`).get()).data().roles, ['orgAdmin']);
  assert.equal((await db.collection(`organizations/${orgId}/audit`).get()).size, 1);
  await assert.rejects(call('org-owner', 'createOrganization', { ...payload, name: 'Changed' }), error => error.details.domainCode === 'REQUEST_ID_REUSED');
  await assert.rejects(call('org-owner', 'createOrganization', req({ name: 'Bad', kind: 'club', timeZone: 'UTC', orgId: a.orgId })), { code: 'functions/invalid-argument' });
});
test('all new callable reads and writes require authentication', async () => {
  for (const name of ['createOrganization', 'saveHierarchyEntity', 'saveTeam', 'setStaffAssignment', 'archiveSeason', 'listMyOrganizations', 'listOrganizationHierarchy', 'listLegacyTeams']) {
    await assert.rejects(call('org-anonymous', name), { code: 'functions/unauthenticated' });
  }
});
test('organization and program scope isolate every hierarchy read/write and assignment', async () => {
  for (const uid of ['org-outsider', 'org-support', 'org-coach']) {
    for (const fixture of [a, b]) {
      await deny(call(uid, 'listOrganizationHierarchy', { orgId: fixture.orgId }));
      for (const [kind, fields] of [['organization', { name: 'Bad', kind: 'club', timeZone: 'UTC', status: 'active' }], ['program', { name: 'Bad', sportCode: 'soccer', status: 'active' }], ['season', { name: 'Bad', programId: fixture.program.id, startsOn: '2026-01-01', endsOn: '2026-12-31', status: 'active' }], ['division', { name: 'Bad', programId: fixture.program.id, seasonId: fixture.season.id, status: 'active' }]]) {
        await deny(entity(fixture.orgId, kind, fields, uid, kind === 'organization' ? { entityId: fixture.orgId, expectedRevision: 1 } : {}));
      }
      await deny(call(uid, 'saveTeam', req({ orgId: fixture.orgId, fields: fixture.teamFields, expectedRevision: 0 })));
      await deny(call(uid, 'archiveSeason', req({ orgId: fixture.orgId, seasonId: fixture.season.id, status: 'archived', expectedRevision: 1 })));
      await deny(call(uid, 'setStaffAssignment', req({ orgId: fixture.orgId, userId: uid, roles: ['orgAdmin'], programIds: [], status: 'active', expectedRevision: 0 })));
    }
  }
  await deny(call('org-staff', 'listOrganizationHierarchy', { orgId: b.orgId }));
  await deny(call('org-staff', 'listOrganizationHierarchy', { orgId: a.orgId, programId: otherProgram.id }));
  assert.deepEqual((await call('org-staff', 'listOrganizationHierarchy', { orgId: a.orgId })).items.map(item => item.id), [a.program.id]);
  for (const kind of ['season', 'division', 'team']) {
    assert.equal((await call('org-staff', 'listOrganizationHierarchy', { orgId: a.orgId, programId: a.program.id, kind })).items.length, 1);
  }
  await assert.rejects(call('org-staff', 'listOrganizationHierarchy', { orgId: a.orgId, kind: 'team' }), { code: 'functions/invalid-argument' });
  await deny(entity(a.orgId, 'season', { name: 'Bad', programId: otherProgram.id, startsOn: '2026-01-01', endsOn: '2026-12-31', status: 'active' }, 'org-staff'));
  await deny(call('org-staff', 'setStaffAssignment', req({ orgId: a.orgId, userId: 'org-staff', roles: ['orgAdmin'], programIds: [], status: 'active', expectedRevision: 1 })));
});
test('hierarchy rejects invalid and foreign references, preserves immutable parents and server metadata', async () => {
  await deny(entity(a.orgId, 'division', { name: 'Bad', programId: a.program.id, seasonId: b.season.id, status: 'active' }));
  await deny(call('org-owner', 'saveTeam', req({ orgId: a.orgId, expectedRevision: 0, fields: { ...a.teamFields, divisionId: b.division.id } })));
  await deny(call('org-owner', 'saveTeam', req({ orgId: b.orgId, teamId: a.team.id, expectedRevision: 1, fields: b.teamFields })));
  await assert.rejects(call('org-owner', 'saveTeam', req({ orgId: a.orgId, teamId: a.team.id, expectedRevision: 1, fields: { ...a.teamFields, programId: otherProgram.id } })), { code: 'functions/invalid-argument' });
  for (const fields of [{ ...a.teamFields, orgId: b.orgId }, { ...a.teamFields, createdBy: 'forged' }]) {
    await assert.rejects(call('org-owner', 'saveTeam', req({ orgId: a.orgId, expectedRevision: 0, fields })), { code: 'functions/invalid-argument' });
  }
  await assert.rejects(entity(a.orgId, 'season', { name: 'Bad', programId: a.program.id, startsOn: '2026-02-30', endsOn: '2026-03-01', status: 'active' }), { code: 'functions/invalid-argument' });
  await deny(call('org-owner', 'setStaffAssignment', req({ orgId: a.orgId, userId: 'org-outsider', roles: ['programStaff'], programIds: [b.program.id], status: 'active', expectedRevision: 0 })));
  const stored = (await db.doc(`teams/${a.team.id}`).get()).data();
  assert.ok(stored.createdAt instanceof Timestamp); assert.equal(stored.createdBy, 'org-owner'); assert.equal(stored.schemaVersion, 2);
});
test('hierarchy pagination returns no unrelated rows and discovery revalidates stale links', async () => {
  const first = await call('org-owner', 'listOrganizationHierarchy', { orgId: a.orgId, pageSize: 1 });
  const second = await call('org-owner', 'listOrganizationHierarchy', { orgId: a.orgId, pageSize: 1, cursor: first.nextCursor });
  assert.equal(first.items.length, 1); assert.equal(second.items.length, 1); assert.notEqual(first.items[0].id, second.items[0].id); assert.equal(second.nextCursor, null);
  await db.doc(`users/org-outsider/organizationLinks/${a.orgId}`).set({ orgId: a.orgId, status: 'active' });
  assert.deepEqual((await call('org-outsider', 'listMyOrganizations')).items, []);
  assert.deepEqual((await call('org-staff', 'listMyOrganizations')).items.map(item => item.id), [a.orgId]);
  for (const size of [0, 51, 1.5]) await assert.rejects(call('org-owner', 'listOrganizationHierarchy', { orgId: a.orgId, pageSize: size }), { code: 'functions/invalid-argument' });
});
test('revision conflicts, retries and audits are atomic and replay cannot bypass revoked staff', async () => {
  const payload = req({ orgId: a.orgId, teamId: a.team.id, fields: { ...a.teamFields, name: 'Edited by staff' }, expectedRevision: 1 });
  const [left, right] = await Promise.all([call('org-staff', 'saveTeam', payload), call('org-staff', 'saveTeam', payload)]);
  assert.deepEqual(left, right); assert.equal(left.team.revision, 2);
  await assert.rejects(call('org-owner', 'saveTeam', req({ orgId: a.orgId, teamId: a.team.id, fields: a.teamFields, expectedRevision: 1 })), error => error.details.domainCode === 'STALE_REVISION');
  const concurrent = await Promise.allSettled(['A', 'B'].map(name => call('org-owner', 'saveTeam', req({ orgId: a.orgId, teamId: a.team.id, fields: { ...a.teamFields, name }, expectedRevision: 2 }))));
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.find(result => result.status === 'rejected').reason.details.domainCode, 'STALE_REVISION');
  const audits = await db.collection(`organizations/${a.orgId}/audit`).where('operation', '==', 'saveTeam').get();
  assert.equal(audits.size, 3);
  await assign('org-staff', ['programStaff'], [a.program.id], 'revoked', 1);
  await deny(call('org-staff', 'saveTeam', payload)); await deny(call('org-staff', 'listOrganizationHierarchy', { orgId: a.orgId }));
  assert.deepEqual((await call('org-staff', 'listMyOrganizations')).items, []);
  await assign('org-staff', ['programStaff'], [a.program.id], 'active', 2);
});
test('v2 event create/update/delete validate every team and deny unrelated/program staff/platform support', async () => {
  const create = (uid, team, event) => call(uid, 'createEvent', req({ teamId: team.id, event: { ...fields, teamIds: [team.id], ...event } }));
  for (const uid of ['org-outsider', 'org-support']) await deny(create(uid, a.team));
  await deny(create('org-staff', b.team)); await deny(create('org-coach', b.team));
  await deny(create('org-owner', a.team, { teamIds: [a.team.id, b.team.id] }));
  for (const patch of [{ endsAt: fields.startsAt }, { teamIds: [a.team.id, a.team.id] }, { status: 'cancelled' }, { publicationState: 'invalid' }, { timeZone: 'Invalid/Zone' }, { orgId: b.orgId }, { publicationOperationId: 'fake' }]) {
    await assert.rejects(create('org-owner', a.team, patch), { code: 'functions/invalid-argument' });
  }
  const event = await create('org-coach', a.team);
  assert.equal(event.orgId, a.orgId); assert.equal(event.divisionId, a.division.id); assert.equal(event.teamId, event.teamIds[0]); assert.equal(event.schemaVersion, 2);
  for (const uid of ['org-outsider', 'org-support']) {
    await deny(call(uid, 'updateEvent', req({ eventId: event.id, expectedRevision: 1, patch: { title: 'Bad' } })));
    await deny(call(uid, 'softDeleteEvent', req({ eventId: event.id, expectedRevision: 1 })));
  }
  for (const patch of [{ orgId: b.orgId }, { programId: b.program.id }, { teamIds: [b.team.id] }, { divisionId: b.division.id }, { publicationOperationId: 'fake' }, { endsAt: fields.startsAt }]) {
    await assert.rejects(call('org-owner', 'updateEvent', req({ eventId: event.id, expectedRevision: 1, patch })), { code: 'functions/invalid-argument' });
  }
  const edit = req({ eventId: event.id, expectedRevision: 1, patch: { title: 'Published practice', publicationState: 'published' } });
  assert.equal((await call('org-staff', 'updateEvent', edit)).revision, 2);
  assert.equal((await call('org-staff', 'updateEvent', edit)).revision, 2);
  await assert.rejects(call('org-owner', 'updateEvent', req({ eventId: event.id, expectedRevision: 1, patch: { title: 'Stale' } })), error => error.details.domainCode === 'STALE_REVISION');
  await db.doc(`events/${event.id}`).update({ orgId: b.orgId });
  await deny(call('org-owner', 'softDeleteEvent', req({ eventId: event.id, expectedRevision: 2 })));
  await db.doc(`events/${event.id}`).update({ orgId: a.orgId });
  assert.equal((await call('org-owner', 'softDeleteEvent', req({ eventId: event.id, expectedRevision: 2 }))).revision, 3);
});
test('multi-team events authorize every coach grant, span divisions canonically and recheck rollout flag', async () => {
  const division = await entity(a.orgId, 'division', { name: 'U14', programId: a.program.id, seasonId: a.season.id, status: 'active' });
  const { team } = await call('org-owner', 'saveTeam', req({ orgId: a.orgId, expectedRevision: 0, fields: { ...a.teamFields, divisionId: division.id } }));
  const payload = req({ teamId: a.team.id, event: { ...fields, teamIds: [a.team.id, team.id] } });
  await deny(call('org-coach', 'createEvent', payload));
  const event = await call('org-staff', 'createEvent', payload); assert.equal(event.divisionId, null);
  await db.doc(`organizations/${a.orgId}`).update({ 'features.organizationV2': false });
  await assert.rejects(call('org-staff', 'createEvent', payload), { code: 'functions/failed-precondition' });
  await db.doc(`organizations/${a.orgId}`).update({ 'features.organizationV2': true });
});
test('season archive is reversible, retains reads/history and rejects all ordinary child edits', async () => {
  const event = await call('org-staff', 'createEvent', req({ teamId: a.team.id, event: { ...fields, teamIds: [a.team.id] } }));
  const originalTeam = (await db.doc(`teams/${a.team.id}`).get()).data();
  const archived = await call('org-staff', 'archiveSeason', req({ orgId: a.orgId, seasonId: a.season.id, expectedRevision: 1, status: 'archived' }));
  assert.equal(archived.season.revision, 2);
  const result = await call('org-staff', 'listOrganizationHierarchy', { orgId: a.orgId, kind: 'season', programId: a.program.id, seasonStatus: 'archived' });
  assert.equal(result.items[0].id, a.season.id);
  await Promise.all([
    call('org-staff', 'saveTeam', req({ orgId: a.orgId, teamId: a.team.id, fields: a.teamFields, expectedRevision: originalTeam.revision })),
    entity(a.orgId, 'division', { name: 'Bad', programId: a.program.id, seasonId: a.season.id, status: 'active' }, 'org-staff'),
    entity(a.orgId, 'season', { name: 'Bad', programId: a.program.id, startsOn: '2026-09-01', endsOn: '2026-12-01', status: 'active' }, 'org-staff', { entityId: a.season.id, expectedRevision: 2 }),
    call('org-staff', 'createEvent', req({ teamId: a.team.id, event: { ...fields, teamIds: [a.team.id] } })),
    call('org-staff', 'updateEvent', req({ eventId: event.id, expectedRevision: 1, patch: { title: 'Bad' } })),
    call('org-staff', 'softDeleteEvent', req({ eventId: event.id, expectedRevision: 1 })),
  ].map(promise => assert.rejects(promise, error => error.details.domainCode === 'HIERARCHY_ARCHIVED')));
  assert.deepEqual((await db.doc(`teams/${a.team.id}`).get()).data(), originalTeam);
  assert.equal((await db.doc(`events/${event.id}`).get()).data().deletedAt, null);
  await call('org-staff', 'archiveSeason', req({ orgId: a.orgId, seasonId: a.season.id, expectedRevision: 2, status: 'active' }));
  assert.equal((await call('org-staff', 'updateEvent', req({ eventId: event.id, expectedRevision: 1, patch: { title: 'Restored' } }))).revision, 2);
});
test('support directory filters v2 teams and refuses ordinary actors', async () => {
  const ref = db.collection('teams').doc(); await ref.set({ name: 'Legacy directory fixture' });
  await deny(call('org-owner', 'listLegacyTeams'));
  let cursor = null; const items = [];
  do { const result = await call('org-support', 'listLegacyTeams', { pageSize: 2, cursor }); items.push(...result.items); cursor = result.nextCursor; } while (cursor);
  assert.ok(items.some(item => item.id === ref.id)); assert.ok(items.every(item => !item.orgId && item.schemaVersion !== 2));
});

test('same-organization program boundary applies to team edits and all event mutations', async () => {
  const season = await entity(a.orgId, 'season', { name: 'Other fall', programId: otherProgram.id, startsOn: '2026-09-01', endsOn: '2026-12-01', status: 'active' });
  const division = await entity(a.orgId, 'division', { name: 'Other division', programId: otherProgram.id, seasonId: season.id, status: 'active' });
  const teamFields = { name: 'Other program team', programId: otherProgram.id, seasonId: season.id, divisionId: division.id, status: 'active' };
  const { team } = await call('org-owner', 'saveTeam', req({ orgId: a.orgId, fields: teamFields, expectedRevision: 0 }));
  await deny(call('org-staff', 'saveTeam', req({ orgId: a.orgId, teamId: team.id, fields: teamFields, expectedRevision: 1 })));
  const eventPayload = req({ teamId: team.id, event: { ...fields, teamIds: [team.id] } });
  await deny(call('org-staff', 'createEvent', eventPayload));
  const event = await call('org-owner', 'createEvent', eventPayload);
  await deny(call('org-staff', 'updateEvent', req({ eventId: event.id, expectedRevision: 1, patch: { title: 'Bad' } })));
  await deny(call('org-staff', 'softDeleteEvent', req({ eventId: event.id, expectedRevision: 1 })));
  const coachPayload = req({ teamId: a.team.id, event: { ...fields, teamIds: [a.team.id] } });
  await call('org-coach', 'createEvent', coachPayload);
  await db.doc(`teamMembers/${a.team.id}_org-coach`).update({ status: 'revoked' });
  await deny(call('org-coach', 'createEvent', coachPayload));
  await db.doc('users/org-staff').update({ accountState: 'deleting' });
  await deny(call('org-staff', 'listMyOrganizations'));
  await deny(call('org-staff', 'archiveSeason', req({ orgId: a.orgId, seasonId: a.season.id, status: 'archived', expectedRevision: 3 })));
  await db.doc('users/org-staff').update({ accountState: 'active' });
});
