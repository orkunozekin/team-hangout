import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { getFirestore as clientDb, connectFirestoreEmulator, doc, getDoc, setDoc } from 'firebase/firestore';
import { projectId, requireEmulators, operationalEventFields } from './fixtures.mjs';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp: adminApp, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { overlaps, occupancy, contains } = require('./lib/facilities/intervals');
const { getAuth: adminAuth } = require('firebase-admin/auth');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
requireEmulators();
let admin, db, seq = 0; const apps = {};
const call = async (uid, name, data = {}) => (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const req = payload => ({ requestId: `p203-${++seq}`, ...payload });
const orgId = 'p203-org', facilityFields = { name: 'Cedar Park', address: '100 Sample Street', timeZone: 'America/Chicago', latitude: 30.3, longitude: -97.7, parking: 'East lot', accessibility: 'Step-free entrance on east side', status: 'active' };
const resourceFields = { label: 'Field 2 North', sports: ['soccer'], setupMinutes: 15, cleanupMinutes: 10, status: 'active' };
const at = (day, hour, minute = 0) => `2035-01-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
const deny = promise => assert.rejects(promise, { code: 'functions/permission-denied' });
const conflict = promise => assert.rejects(promise, e => e.details?.domainCode === 'SCHEDULE_CONFLICT');
async function catalog(fields = {}) {
  const { facility } = await call('p203-admin', 'saveFacility', req({ orgId, expectedRevision: 0, fields: facilityFields }));
  const { resource } = await call('p203-admin', 'saveFacilityResource', req({ orgId, facilityId: facility.id, expectedRevision: 0, fields: { ...resourceFields, ...fields } }));
  const scope = { orgId, facilityId: facility.id, resourceId: resource.id };
  await call('p203-admin', 'appendResourceAvailability', req({ ...scope, expectedRevision: 1, effectiveFrom: at(1, 0), windows: [{ startsAt: at(1, 0), endsAt: at(31, 23) }] }));
  return { ...scope, facility, resource: { ...resource, revision: 2 } };
}
async function create(c, startsAt = at(2, 12), endsAt = at(2, 13), extra = {}) {
  return call('p203-admin', 'createEvent', req({ teamId: 'p203-a', event: { ...operationalEventFields, teamIds: ['p203-a'], publicationState: 'published', startsAt, endsAt, facilityId: c.facilityId, resourceId: c.resourceId, ...extra } }));
}
const mutate = (event, action, patch = {}) => call('p203-admin', 'mutateEventSchedule', req({ eventId: event.id, expectedRevision: event.revision, action, patch, reason: 'Synthetic resource change' }));
before(async () => {
  admin = adminApp({ projectId }); db = getFirestore(admin);
  for (const uid of ['p203-admin', 'p203-staff', 'p203-outsider', 'p203-support', 'p203-coach']) {
    const app = initializeApp({ projectId, apiKey: 'demo-key' }, uid); apps[uid] = app;
    connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), '127.0.0.1', 5001); connectFirestoreEmulator(clientDb(app), '127.0.0.1', 8080);
    await adminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password: 'SyntheticPassword123!' });
    await db.doc(`users/${uid}`).set({ uid, appRole: uid === 'p203-support' ? 'superAdmin' : 'user' });
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, 'SyntheticPassword123!');
  }
  const meta = { schemaVersion: 2, revision: 1, status: 'active' }, scope = { orgId, programId: 'p203-program', seasonId: 'p203-season', divisionId: 'p203-division' };
  await db.doc(`organizations/${orgId}`).set({ ...meta, name: 'Synthetic league', timeZone: 'America/Chicago', features: { organizationV2: true, adminWorkspace: true } });
  for (const [kind, name] of [['programs', 'p203-program'], ['seasons', 'p203-season'], ['divisions', 'p203-division']]) await db.doc(`organizations/${orgId}/${kind}/${name}`).set({ ...meta, ...scope, name, sportCode: 'soccer' });
  await db.doc(`organizations/${orgId}/members/p203-admin`).set({ ...meta, orgId, roles: ['orgAdmin'], programIds: [] });
  await db.doc(`organizations/${orgId}/members/p203-staff`).set({ ...meta, orgId, roles: ['programStaff'], programIds: ['p203-program'] });
  await db.doc('teams/p203-a').set({ ...meta, ...scope, name: 'Falcons', sport: 'soccer' });
  await db.doc('teamMembers/p203-a_p203-coach').set({ ...meta, orgId, teamId: 'p203-a', userId: 'p203-coach', roles: ['coach'] });
});
after(async () => { await Promise.all(Object.values(apps).map(deleteApp)); await deleteAdmin(admin); });
test('intervals are half open, include buffers, midnight and continuous adjacent windows', () => {
  const first = occupancy({ startsAt: at(2, 23), endsAt: at(3, 0) }, 15, 10);
  assert.deepEqual(first, { startsAt: at(2, 22, 45), endsAt: at(3, 0, 10) });
  assert.equal(overlaps(first, { startsAt: at(3, 0, 10), endsAt: at(3, 1) }), false);
  assert.equal(overlaps(first, { startsAt: at(3, 0, 9), endsAt: at(3, 1) }), true);
  assert.equal(contains([{ startsAt: at(2, 22), endsAt: at(3, 0) }, { startsAt: at(3, 0), endsAt: at(3, 1) }], first), true);
  assert.equal(contains([{ startsAt: at(2, 22), endsAt: at(2, 23, 59) }, { startsAt: at(3, 0), endsAt: at(3, 1) }], first), false);
});
test('catalog allowlists, pagination, tenant boundaries, live scopes and revoked receipt replay', async () => {
  const c = await catalog();
  const rows = await call('p203-staff', 'listFacilities', { orgId, pageSize: 1 });
  assert.equal(rows.canManage, false); assert.equal(rows.items.length, 1);
  assert.equal(rows.items[0].createdBy, undefined); assert.equal(rows.items[0].auditCorrelationId, undefined);
  for (const uid of ['p203-outsider', 'p203-support', 'p203-coach']) await deny(call(uid, 'listFacilities', { orgId }));
  await deny(call('p203-staff', 'saveFacility', req({ orgId, expectedRevision: 0, fields: facilityFields })));
  await deny(call('p203-admin', 'listFacilityResources', { orgId: 'foreign', facilityId: c.facilityId }));
  await deny(call('p203-admin', 'listFacilityResources', { orgId, facilityId: 'foreign' }));
  const payload = req({ orgId, facilityId: c.facilityId, expectedRevision: 1, fields: { ...facilityFields, name: 'Renamed park' } });
  const first = await call('p203-admin', 'saveFacility', payload);
  assert.deepEqual(await call('p203-admin', 'saveFacility', payload), first);
  await assert.rejects(call('p203-admin', 'saveFacility', { ...payload, fields: facilityFields }), e => e.details.domainCode === 'REQUEST_ID_REUSED');
  await db.doc(`organizations/${orgId}/members/p203-admin`).update({ status: 'revoked' });
  await deny(call('p203-admin', 'saveFacility', payload));
  await db.doc(`organizations/${orgId}/members/p203-admin`).update({ status: 'active' });
  await db.doc(`organizations/${orgId}/programs/p203-program`).update({ status: 'archived' });
  await deny(call('p203-staff', 'listFacilities', { orgId }));
  await db.doc(`organizations/${orgId}/programs/p203-program`).update({ status: 'active' });
  for (const path of [`organizations/${orgId}/facilities/${c.facilityId}`, `organizations/${orgId}/facilities/${c.facilityId}/resources/${c.resourceId}/availability/2`]) {
    await assert.rejects(getDoc(doc(clientDb(apps['p203-admin']), path)), { code: 'permission-denied' });
    await assert.rejects(setDoc(doc(clientDb(apps['p203-admin']), path), { status: 'active' }, { merge: true }), { code: 'permission-denied' });
  }
});
test('exact labels, snapshot buffers, bounded overlaps and simultaneous bookings', async () => {
  const c = await catalog();
  const first = await create(c); assert.equal(first.location.name, 'Cedar Park · Field 2 North');
  const loaded = await call('p203-coach', 'getCanonicalEvent', { eventId: first.id });
  assert.equal(loaded.location.address, facilityFields.address); assert.equal(loaded.resourceOccupancy, undefined); assert.equal(loaded.resourceDetails, undefined);
  await conflict(create(c, at(2, 13), at(2, 14)));
  const adjacent = await create(c, at(2, 13, 25), at(2, 14, 25)); assert.ok(adjacent.id);
  await conflict(create(c, at(2, 13, 24), at(2, 14, 24)));
  const midnight = await create(c, at(3, 23), at(4, 0));
  await conflict(create(c, at(4, 0), at(4, 1)));
  const concurrent = await Promise.allSettled([create(c, at(5, 12), at(5, 13)), create(c, at(5, 12), at(5, 13))]);
  assert.equal(concurrent.filter(row => row.status === 'fulfilled').length, 1);
  await assert.rejects(create(c, at(7, 0), at(9, 0)), { code: 'functions/invalid-argument' });
  const stored = (await db.doc(`events/${midnight.id}`).get()).data(); assert.equal(stored.resourceOccupancy.endsAt.toDate().toISOString(), at(4, 0, 10));
  const { resource } = await call('p203-admin', 'saveFacilityResource', req({ orgId, facilityId: c.facilityId, resourceId: c.resourceId, expectedRevision: 2, fields: { ...resourceFields, setupMinutes: 30, label: 'Field 2 North Updated' } }));
  assert.equal(resource.revision, 3); assert.equal((await db.doc(`events/${first.id}`).get()).data().resourceOccupancy.setupMinutes, 15);
  assert.equal((await db.doc(`events/${first.id}`).get()).data().location.name, 'Cedar Park · Field 2 North');
  await mutate(first, 'edit', { title: 'Title correction' });
  assert.equal((await db.doc(`events/${first.id}`).get()).data().resourceOccupancy.setupMinutes, 15);
});
test('lifecycle and compatibility paths cannot bypass occupancy; history survives release', async () => {
  const c = await catalog(), staged = await create(c, at(2, 12), at(2, 13), { publicationState: 'staged' }), first = await create(c);
  await conflict(call('p203-admin', 'updateEvent', req({ eventId: staged.id, expectedRevision: 1, patch: { publicationState: 'published' } })));
  await mutate(first, 'postpone');
  const promoted = await call('p203-admin', 'updateEvent', req({ eventId: staged.id, expectedRevision: 1, patch: { publicationState: 'published' } }));
  await conflict(mutate({ id: first.id, revision: 2 }, 'reschedule', { startsAt: at(2, 12, 1), endsAt: at(2, 13, 1), timeZone: 'America/Chicago' }));
  await mutate({ id: staged.id, revision: promoted.revision }, 'cancel');
  const rescheduled = await mutate({ id: first.id, revision: 2 }, 'reschedule', { startsAt: at(3, 12), endsAt: at(3, 13), timeZone: 'America/Chicago' });
  await mutate(rescheduled, 'complete');
  await conflict(create(c, at(3, 12), at(3, 13)));
  assert.equal((await db.collection(`events/${first.id}/resourceHistory`).get()).size, 4);
  assert.equal((await db.collection(`events/${first.id}/scheduleHistory`).get()).size, 3);
  const detached = await create(c, at(4, 12), at(4, 13));
  await mutate(detached, 'edit', { facilityId: null, resourceId: null });
  assert.equal((await db.doc(`events/${detached.id}`).get()).data().resourceOccupancy, null);
  assert.ok((await create(c, at(4, 12), at(4, 13))).id);
  await assert.rejects(mutate(rescheduled, 'edit', { resourceOccupancy: {} }), { code: 'functions/invalid-argument' });
});
test('immutable effective revisions, active states and sports compatibility are authoritative', async () => {
  const c = await catalog();
  const append = (effectiveFrom, windows, expectedRevision = 2) => call('p203-admin', 'appendResourceAvailability', req({ orgId, facilityId: c.facilityId, resourceId: c.resourceId, expectedRevision, effectiveFrom, windows }));
  await create(c);
  await conflict(append(at(2, 0), []));
  await append(at(3, 0), [{ startsAt: at(3, 10), endsAt: at(3, 14) }]);
  await conflict(create(c, at(3, 10), at(3, 11)));
  await create(c, at(3, 10, 15), at(3, 11, 15));
  await conflict(create(c, at(2, 23), at(3, 0)));
  await assert.rejects(append(at(2, 0), [], 3), { code: 'functions/invalid-argument' });
  const revisions = await call('p203-staff', 'listResourceAvailability', { orgId, facilityId: c.facilityId, resourceId: c.resourceId, pageSize: 1 });
  assert.equal(revisions.items[0].revision, 3); assert.ok(revisions.nextCursor);
  const older = await call('p203-staff', 'listResourceAvailability', { orgId, facilityId: c.facilityId, resourceId: c.resourceId, pageSize: 1, cursor: revisions.nextCursor });
  assert.equal(older.items[0].revision, 2);
  await conflict(call('p203-admin', 'saveFacility', req({ orgId, facilityId: c.facilityId, expectedRevision: 1, fields: { ...facilityFields, status: 'inactive' } })));
  await conflict(call('p203-admin', 'saveFacilityResource', req({ orgId, facilityId: c.facilityId, resourceId: c.resourceId, expectedRevision: 3, fields: { ...resourceFields, status: 'inactive' } })));
  const incompatible = await catalog({ sports: ['basketball'] }); await conflict(create(incompatible));
  const unavailable = await catalog({ status: 'inactive' }); await conflict(create(unavailable));
  const none = await call('p203-admin', 'saveFacilityResource', req({ orgId, facilityId: c.facilityId, expectedRevision: 0, fields: resourceFields }));
  await conflict(create({ facilityId: c.facilityId, resourceId: none.resource.id }));
  await assert.rejects(call('p203-admin', 'saveFacility', req({ orgId, expectedRevision: 0, fields: { ...facilityFields, latitude: 91 } })), { code: 'functions/invalid-argument' });
});

test('availability changes protect cleanup crossing the effective boundary and reject stale resource writes', async () => {
  const c = await catalog();
  await create(c, at(2, 22), at(2, 23, 55));
  await conflict(call('p203-admin', 'appendResourceAvailability', req({ orgId, facilityId: c.facilityId, resourceId: c.resourceId, expectedRevision: 2, effectiveFrom: at(3, 0), windows: [] })));
  await assert.rejects(call('p203-admin', 'saveFacilityResource', req({ orgId, facilityId: c.facilityId, resourceId: c.resourceId, expectedRevision: 1, fields: resourceFields })), e => e.details.domainCode === 'STALE_REVISION');
});

test('reservation queries fail closed at the declared bound, without committing a partial booking', async () => {
  const c = await catalog();
  const span = { startsAt: Timestamp.fromDate(new Date(at(2, 12))), endsAt: Timestamp.fromDate(new Date(at(2, 13))) };
  for (let offset = 0; offset < 501; offset += 250) {
    const batch = db.batch();
    for (let i = offset; i < Math.min(501, offset + 250); i++) batch.set(db.doc(`events/p203-bound-${i}`), { ...span, orgId, facilityId: c.facilityId, resourceId: c.resourceId, publicationState: 'staged', status: 'scheduled', deletedAt: null });
    await batch.commit();
  }
  await assert.rejects(create(c), { code: 'functions/resource-exhausted' });
  const rows = await db.collection('events').where('orgId', '==', orgId).where('resourceId', '==', c.resourceId).get();
  assert.equal(rows.size, 501); assert.ok(rows.docs.every(row => row.data().publicationState === 'staged'));
});

test('availability revision and booking races serialize against the same resource', async () => {
  const c = await catalog();
  const outcomes = await Promise.allSettled([
    create(c, at(3, 12), at(3, 13)),
    call('p203-admin', 'appendResourceAvailability', req({ orgId, facilityId: c.facilityId, resourceId: c.resourceId, expectedRevision: 2, effectiveFrom: at(3, 0), windows: [] })),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(result => result.status === 'rejected'); assert.equal(rejected.reason.details.domainCode, 'SCHEDULE_CONFLICT');
  const originals = await db.doc(`organizations/${orgId}/facilities/${c.facilityId}/resources/${c.resourceId}/revisions/1`).get();
  assert.equal(originals.data().label, 'Field 2 North'); assert.equal(originals.data().setupMinutes, 15);
});
