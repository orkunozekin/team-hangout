import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { projectId, requireEmulators, operationalEventFields } from './fixtures.mjs';
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
const fields = operationalEventFields;
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
  await assert.rejects(call('org-owner', 'mutateEventSchedule', req({ eventId: event.id, expectedRevision: 1, action: 'edit', reason: 'Stale edit', patch: { title: 'Stale' } })), error => error.details.domainCode === 'STALE_REVISION');
  await db.doc(`events/${event.id}`).update({ orgId: b.orgId });
  await deny(call('org-owner', 'softDeleteEvent', req({ eventId: event.id, expectedRevision: 2 })));
  await db.doc(`events/${event.id}`).update({ orgId: a.orgId });
  assert.equal((await call('org-owner', 'softDeleteEvent', req({ eventId: event.id, expectedRevision: 2 }))).revision, 3);
});
test('successful time edits replay after later edits but still recheck coach authority', async () => {
  const fixtureData = await fixture('Time retry fixture');
  const memberRef = db.doc(`teamMembers/${fixtureData.team.id}_org-coach`);
  await memberRef.set({ orgId: fixtureData.orgId, teamId: fixtureData.team.id, userId: 'org-coach', roles: ['coach'], role: 'coach', status: 'active', schemaVersion: 2 });
  const event = await call('org-coach', 'createEvent', req({ teamId: fixtureData.team.id, event: { ...fields, publicationState: 'published', teamIds: [fixtureData.team.id] } }));
  const firstEdit = req({ eventId: event.id, expectedRevision: 1, action: 'reschedule', reason: 'Extra time', patch: { startsAt: fields.startsAt, endsAt: '2026-10-12T01:00:00.000Z', timeZone: 'America/Chicago' } });
  const saved = await call('org-coach', 'mutateEventSchedule', firstEdit);
  await call('org-coach', 'mutateEventSchedule', req({ eventId: event.id, expectedRevision: 2, action: 'reschedule', reason: 'Later start', patch: { startsAt: '2026-10-12T02:00:00.000Z', endsAt: '2026-10-12T03:00:00.000Z', timeZone: 'America/Chicago' } }));
  const beforeReplay = (await db.doc(`events/${event.id}`).get()).data();
  const auditBefore = await db.collection(`organizations/${fixtureData.orgId}/audit`).get();
  assert.deepEqual(await call('org-coach', 'mutateEventSchedule', firstEdit), saved);
  assert.deepEqual((await db.doc(`events/${event.id}`).get()).data(), beforeReplay);
  assert.equal((await db.collection(`organizations/${fixtureData.orgId}/audit`).get()).size, auditBefore.size);
  await memberRef.update({ status: 'revoked' });
  await deny(call('org-coach', 'mutateEventSchedule', firstEdit));
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
test('completed hierarchy and event commands replay after archive without writes and still require authority', async () => {
  const f = await fixture('Archived replay fixture');
  const requests = [
    ['saveTeam', req({ orgId: f.orgId, teamId: f.team.id, fields: { ...f.teamFields, name: 'Saved team' }, expectedRevision: 1 })],
    ['saveHierarchyEntity', req({ orgId: f.orgId, kind: 'season', entityId: f.season.id, expectedRevision: 1, fields: { name: 'Saved season', programId: f.program.id, startsOn: '2026-09-01', endsOn: '2026-12-01', status: 'active' } })],
    ['saveHierarchyEntity', req({ orgId: f.orgId, kind: 'division', entityId: f.division.id, expectedRevision: 1, fields: { name: 'Saved division', programId: f.program.id, seasonId: f.season.id, status: 'active' } })],
    ['archiveSeason', req({ orgId: f.orgId, seasonId: f.season.id, expectedRevision: 2, status: 'active' })],
    ['setStaffAssignment', req({ orgId: f.orgId, userId: 'org-outsider', roles: ['programStaff'], programIds: [f.program.id], status: 'active', expectedRevision: 0 })],
    ['createEvent', req({ teamId: f.team.id, event: { ...fields, teamIds: [f.team.id] } })],
  ];
  const saved = [];
  for (const [name, payload] of requests) saved.push(await call('org-owner', name, payload));
  requests.push(['updateEvent', req({ eventId: saved[5].id, expectedRevision: 1, patch: { title: 'Saved event' } })]);
  saved.push(await call('org-owner', ...requests[6]));
  for (const path of [`organizations/${f.orgId}`, `organizations/${f.orgId}/programs/${f.program.id}`, `organizations/${f.orgId}/seasons/${f.season.id}`, `organizations/${f.orgId}/divisions/${f.division.id}`, `teams/${f.team.id}`]) {
    await db.doc(path).update({ status: 'archived' });
  }
  const paths = [`teams/${f.team.id}`, `events/${saved[5].id}`, `organizations/${f.orgId}/seasons/${f.season.id}`, `organizations/${f.orgId}/divisions/${f.division.id}`];
  const before = await Promise.all(paths.map(async path => (await db.doc(path).get()).data()));
  const audits = await db.collection(`organizations/${f.orgId}/audit`).get();
  for (let i = 0; i < requests.length; i++) assert.deepEqual(await call('org-owner', ...requests[i]), saved[i]);
  assert.deepEqual(await Promise.all(paths.map(async path => (await db.doc(path).get()).data())), before);
  assert.equal((await db.collection(`organizations/${f.orgId}/audit`).get()).size, audits.size);
  for (const [name, payload] of requests) await assert.rejects(call('org-owner', name, req({ ...payload, requestId: `new-archive-${++sequence}` })), error => error.details.domainCode === 'HIERARCHY_ARCHIVED');
  await db.doc(`organizations/${f.orgId}/members/org-owner`).update({ status: 'revoked' });
  for (const [name, payload] of requests) await deny(call('org-owner', name, payload));
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

test('browser workspace entry requires rollout and live staff; staff lists are admin-only and paginated', async () => {
  const fixtureData = await fixture('Browser workspace');
  const orgId = fixtureData.orgId;
  await assert.rejects(call('org-owner', 'getAdminWorkspace', { orgId }), error => error.details.domainCode === 'ADMIN_WORKSPACE_DISABLED');
  await db.doc(`organizations/${orgId}`).update({ 'features.adminWorkspace': true });
  const context = await call('org-owner', 'getAdminWorkspace', { orgId });
  assert.equal(context.admin, true); assert.equal(context.organization.revision, 1);
  assert.deepEqual(Object.keys(context.organization).sort(), ['id', 'kind', 'name', 'revision', 'status', 'timeZone']);
  assert.equal(context.organization.name, 'Browser workspace');
  await call('org-owner', 'setStaffAssignment', req({ orgId, userId: 'org-staff', roles: ['programStaff'], programIds: [fixtureData.program.id], status: 'active', expectedRevision: 0 }));
  assert.deepEqual((await call('org-staff', 'getAdminWorkspace', { orgId })).programIds, [fixtureData.program.id]);
  await deny(call('org-staff', 'listOrganizationStaff', { orgId }));
  const first = await call('org-owner', 'listOrganizationStaff', { orgId, pageSize: 1 });
  const second = await call('org-owner', 'listOrganizationStaff', { orgId, pageSize: 1, cursor: first.nextCursor });
  assert.equal(first.items.length, 1); assert.equal(second.items.length, 1); assert.notEqual(first.items[0].id, second.items[0].id); assert.equal(second.nextCursor, null);
  assert.deepEqual(Object.keys(first.items[0]).sort(), ['id', 'programIds', 'revision', 'roles', 'status']);
  for (const uid of ['org-outsider', 'org-support', 'org-coach']) {
    await deny(call(uid, 'getAdminWorkspace', { orgId })); await deny(call(uid, 'listOrganizationStaff', { orgId }));
  }
  for (const endpoint of ['getAdminWorkspace', 'listOrganizationStaff']) {
    await assert.rejects(call('org-anonymous', endpoint, { orgId }), { code: 'functions/unauthenticated' });
  }
  await db.doc(`organizations/${orgId}/members/org-staff`).update({ status: 'revoked' });
  await deny(call('org-staff', 'getAdminWorkspace', { orgId }));
  await db.doc(`organizations/${orgId}`).update({ status: 'archived' });
  assert.equal((await call('org-owner', 'getAdminWorkspace', { orgId })).organization.status, 'archived');
});


test('operational foundations reject spoofed actors, malformed grants and cross-org receipt reuse', async () => {
  const f = await fixture('Operational boundary');
  const payload = req({ teamId: f.team.id, event: { ...fields, teamIds: [f.team.id] } });
  for (const patch of [{ userId: 'org-owner' }, { actorUid: 'org-owner' }, { orgId: f.orgId }]) {
    await assert.rejects(call('org-outsider', 'createEvent', { ...payload, ...patch }), { code: 'functions/invalid-argument' });
  }
  const grant = db.doc(`organizations/${f.orgId}/members/org-outsider`);
  for (const roles of ['orgAdmin', '[orgAdmin]', { orgAdmin: true }]) {
    await grant.set({ orgId: f.orgId, status: 'active', roles, programIds: [] });
    await deny(call('org-outsider', 'createEvent', payload));
  }
  await grant.delete();
  const coach = db.doc(`teamMembers/${f.team.id}_org-coach`);
  await coach.set({ orgId: f.orgId, teamId: f.team.id, userId: 'org-coach', roles: 'coach', status: 'active' });
  await deny(call('org-coach', 'createEvent', payload));
  await coach.update({ roles: ['coach'] });
  const saved = await call('org-coach', 'createEvent', payload);
  const spoofed = { ...payload, event: { ...payload.event, createdBy: 'org-owner' } };
  await assert.rejects(call('org-coach', 'createEvent', spoofed), { code: 'functions/invalid-argument' });
  await assert.rejects(call('org-coach', 'createEvent', { ...payload, teamId: b.team.id,
    event: { ...fields, teamIds: [b.team.id] } }), error => error.details.domainCode === 'REQUEST_ID_REUSED');
  const edit = req({ eventId: saved.id, expectedRevision: 1, patch: { title: 'Saved once' } });
  const results = await Promise.allSettled(['First', 'Second'].map(title => call('org-coach', 'updateEvent', req({ ...edit,
    requestId: `operational-${title}`, patch: { title } }))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.details.domainCode, 'STALE_REVISION');
  await coach.update({ status: 'revoked' });
  await deny(call('org-coach', 'createEvent', payload));
  await db.doc('users/org-coach').update({ accountState: 'deleting' });
  await deny(call('org-coach', 'createEvent', payload));
  await db.doc('users/org-coach').update({ accountState: 'active' });
});
