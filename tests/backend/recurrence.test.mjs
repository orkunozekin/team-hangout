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

const { getAuth: adminAuth } = require('firebase-admin/auth');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
requireEmulators();
let admin, db, seq = 0; const apps = {};
const call = async (uid, name, data = {}) => (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const req = payload => ({ requestId: `p204-${++seq}`, ...payload });
const orgId = 'p204-org', facilityFields = { name: 'Cedar Park', address: '100 Sample Street', timeZone: 'America/Chicago', latitude: 30.3, longitude: -97.7, parking: 'East lot', accessibility: 'Step-free entrance on east side', status: 'active' };
const resourceFields = { label: 'Field 2 North', sports: ['soccer'], setupMinutes: 15, cleanupMinutes: 10, status: 'active' };
const at = (day, hour, minute = 0) => `2035-01-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
const deny = promise => assert.rejects(promise, { code: 'functions/permission-denied' });
const conflict = promise => assert.rejects(promise, e => e.details?.domainCode === 'SCHEDULE_CONFLICT');
before(async () => {
  admin = adminApp({ projectId }); db = getFirestore(admin);
  for (const uid of ['p204-admin', 'p204-staff', 'p204-outsider', 'p204-support', 'p204-coach']) {
    const app = initializeApp({ projectId, apiKey: 'demo-key' }, uid); apps[uid] = app;
    connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), '127.0.0.1', 5001); connectFirestoreEmulator(clientDb(app), '127.0.0.1', 8080);
    await adminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password: 'SyntheticPassword123!' });
    await db.doc(`users/${uid}`).set({ uid, appRole: uid === 'p204-support' ? 'superAdmin' : 'user' });
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, 'SyntheticPassword123!');
  }
  const meta = { schemaVersion: 2, revision: 1, status: 'active' }, scope = { orgId, programId: 'p204-program', seasonId: 'p204-season', divisionId: 'p204-division' };
  await db.doc(`organizations/${orgId}`).set({ ...meta, name: 'Synthetic league', timeZone: 'America/Chicago', features: { organizationV2: true, adminWorkspace: true } });
  for (const [kind, name] of [['programs', 'p204-program'], ['seasons', 'p204-season'], ['divisions', 'p204-division']]) await db.doc(`organizations/${orgId}/${kind}/${name}`).set({ ...meta, ...scope, name, sportCode: 'soccer', startsOn: '2035-01-01', endsOn: '2035-12-31' });
  await db.doc(`organizations/${orgId}/members/p204-admin`).set({ ...meta, orgId, roles: ['orgAdmin'], programIds: [] });
  await db.doc(`organizations/${orgId}/members/p204-staff`).set({ ...meta, orgId, roles: ['programStaff'], programIds: ['p204-program'] });
  await db.doc('teams/p204-a').set({ ...meta, ...scope, name: 'Falcons', sport: 'soccer' });
  await db.doc('teamMembers/p204-a_p204-coach').set({ ...meta, orgId, teamId: 'p204-a', userId: 'p204-coach', roles: ['coach'] });
});
after(async () => { await Promise.all(Object.values(apps).map(deleteApp)); await deleteAdmin(admin); });
const fields = { title: 'Sunday practice', startsOn: '2035-11-04', endsOn: '2035-11-18', weekdays: [0], localTime: '01:30', timeZone: 'America/Chicago', durationMinutes: 60, exclusions: [], offsets: {}, facilityId: null, resourceId: null };
let sequence = 0;
const input = patch => ({ orgId, teamId: 'p204-a', seriesId: `series-${++sequence}`, expectedRevision: 0, fields, ...patch });
const preview = (data, uid = 'p204-admin') => call(uid, 'previewRecurrenceDraft', data);
const save = async (data, uid = 'p204-admin') => {
  const result = await preview(data, uid);
  return call(uid, 'saveRecurrenceDraft', req({ ...data, reviewed: true, previewHash: result.previewHash }));
};
test('explicit DST correction, finite review and deterministic retries create only a private draft', async () => {
  const data = input(), first = await preview(data); assert.equal(first.occurrences[0].startsAt, null);
  await assert.rejects(call('p204-admin', 'saveRecurrenceDraft', req({ ...data, reviewed: true, previewHash: first.previewHash })), { code: 'functions/invalid-argument' });
  const corrected = { ...data, fields: { ...fields, offsets: { '2035-11-04': -360 } } };
  const result = await preview(corrected);
  const payload = req({ ...corrected, reviewed: true, previewHash: result.previewHash });
  await assert.rejects(call('p204-admin', 'saveRecurrenceDraft', { ...payload, reviewed: false }), { code: 'functions/invalid-argument' });
  const saves = await Promise.all([call('p204-admin', 'saveRecurrenceDraft', payload), call('p204-admin', 'saveRecurrenceDraft', payload)]);
  assert.deepEqual(saves[0], saves[1]); assert.equal(saves[0].revision, 1);
  assert.equal((await db.collection(`organizations/${orgId}/scheduleSeries/${data.seriesId}/revisions`).get()).size, 1);
  assert.equal((await db.collection('events').where('orgId', '==', orgId).get()).size, 0);
  for (const path of [`organizations/${orgId}/scheduleSeries/${data.seriesId}`, `organizations/${orgId}/scheduleSeries/${data.seriesId}/revisions/1`]) {
    await assert.rejects(getDoc(doc(clientDb(apps['p204-admin']), path)), { code: 'permission-denied' });
    await assert.rejects(setDoc(doc(clientDb(apps['p204-admin']), path), {}), { code: 'permission-denied' });
  }
  await assert.rejects(call('p204-admin', 'saveRecurrenceDraft', { ...payload, fields: { ...corrected.fields, title: 'Changed' } }), e => e.details?.domainCode === 'REQUEST_ID_REUSED');
  await db.doc(`organizations/${orgId}/members/p204-admin`).update({ status: 'revoked' });
  await deny(call('p204-admin', 'saveRecurrenceDraft', payload)); await deny(call('p204-admin', 'getRecurrenceDraft', { orgId, seriesId: data.seriesId }));
  await db.doc(`organizations/${orgId}/members/p204-admin`).update({ status: 'active' });
});
test('series revisions keep IDs, immutable history and reject stale concurrent edits', async () => {
  const data = input({ fields: { ...fields, localTime: '17:00' } }); const first = await save(data);
  const next = { ...data, expectedRevision: 1, fields: { ...data.fields, title: 'Revised practice', localTime: '18:00', exclusions: ['2035-11-11'] } };
  const reviewed = await preview(next); const payload = req({ ...next, previewHash: reviewed.previewHash, reviewed: true });
  const results = await Promise.allSettled([call('p204-admin', 'saveRecurrenceDraft', payload), call('p204-admin', 'saveRecurrenceDraft', { ...payload, requestId: 'competing' })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.details.domainCode, 'STALE_REVISION');
  const current = await call('p204-staff', 'getRecurrenceDraft', { orgId, seriesId: data.seriesId });
  assert.equal(current.revision, 2); assert.equal(current.occurrences[0].id, first.occurrences[0].id); assert.equal(current.occurrences.length, 2);
  const history = (await db.doc(`organizations/${orgId}/scheduleSeries/${data.seriesId}/revisions/1`).get()).data();
  assert.equal(history.fields.localTime, '17:00'); assert.equal(history.occurrences.length, 3);
  assert.equal(current.reviewedBy, undefined);
});
test('staff-only scope, live program and rollout checks cover discovery, read and replay', async () => {
  const data = input({ fields: { ...fields, localTime: '17:00' } }); const saved = await save(data, 'p204-staff');
  for (const uid of ['p204-outsider', 'p204-support', 'p204-coach']) {
    await deny(preview(input(), uid)); await deny(call(uid, 'getRecurrenceDraft', { orgId, seriesId: saved.seriesId }));
  }
  await deny(preview(input({ orgId: 'foreign' }))); await deny(preview(input({ teamId: 'foreign' })));
  await db.doc(`organizations/${orgId}/members/p204-staff`).update({ programIds: ['another-program'] });
  await deny(call('p204-staff', 'getRecurrenceDraft', { orgId, seriesId: saved.seriesId }));
  await db.doc(`organizations/${orgId}/members/p204-staff`).update({ programIds: ['p204-program'] });
  const draft = input({ fields: { ...fields, localTime: '17:00' } }); const p = await preview(draft); const payload = req({ ...draft, previewHash: p.previewHash, reviewed: true });
  await call('p204-admin', 'saveRecurrenceDraft', payload);
  await db.doc(`organizations/${orgId}`).update({ 'features.adminWorkspace': false });
  await deny(preview(draft)); await deny(call('p204-admin', 'saveRecurrenceDraft', payload));
  await db.doc(`organizations/${orgId}`).update({ 'features.adminWorkspace': true });
  await db.doc(`organizations/${orgId}/seasons/p204-season`).update({ status: 'archived' });
  await assert.rejects(preview(input()), e => e.details?.domainCode === 'HIERARCHY_ARCHIVED');
  await db.doc(`organizations/${orgId}/seasons/p204-season`).update({ status: 'active' });
  await assert.rejects(preview(input({ fields: { ...fields, startsOn: '2034-11-04', endsOn: '2034-11-18' } })), { code: 'functions/invalid-argument' });
});
test('resource buffers and changed availability invalidate reviewed preview without reserving', async () => {
  const { facility } = await call('p204-admin', 'saveFacility', req({ orgId, expectedRevision: 0, fields: facilityFields }));
  const { resource } = await call('p204-admin', 'saveFacilityResource', req({ orgId, facilityId: facility.id, expectedRevision: 0, fields: resourceFields }));
  const resourceScope = { orgId, facilityId: facility.id, resourceId: resource.id };
  const data = input({ fields: { ...fields, localTime: '17:00', facilityId: facility.id, resourceId: resource.id } });
  const unavailable = await preview(data); assert.equal(unavailable.diagnostics.length, 3);
  await call('p204-admin', 'appendResourceAvailability', req({ ...resourceScope, expectedRevision: 1, effectiveFrom: '2035-01-01T00:00:00.000Z', windows: [{ startsAt: '2035-01-01T00:00:00.000Z', endsAt: '2036-01-01T00:00:00.000Z' }] }));
  await assert.rejects(call('p204-admin', 'saveRecurrenceDraft', req({ ...data, reviewed: true, previewHash: unavailable.previewHash })), e => e.details?.domainCode === 'STALE_PREVIEW');
  const valid = await preview(data); assert.equal(valid.diagnostics.length, 0);
  await save(data); assert.equal((await db.doc(`organizations/${orgId}/facilities/${facility.id}/resources/${resource.id}`).get()).data().reservationVersion, undefined);
  const daily = await preview(input({ fields: { ...data.fields, startsOn: '2035-11-05', endsOn: '2035-11-06', weekdays: [1,2], durationMinutes: 1440 } }));
  assert.ok(daily.diagnostics.some(d => /cleanup overlaps/.test(d.message)));
  await deny(preview(input({ fields: { ...data.fields, facilityId: 'foreign' } })));
});
test('query read budget fails closed across a finite series', async () => {
  const { facility } = await call('p204-admin', 'saveFacility', req({ orgId, expectedRevision: 0, fields: facilityFields }));
  const { resource } = await call('p204-admin', 'saveFacilityResource', req({ orgId, facilityId: facility.id, expectedRevision: 0, fields: resourceFields }));
  await call('p204-admin', 'appendResourceAvailability', req({ orgId, facilityId: facility.id, resourceId: resource.id, expectedRevision: 1, effectiveFrom: '2035-01-01T00:00:00.000Z', windows: [{ startsAt: '2035-01-01T00:00:00.000Z', endsAt: '2036-01-01T00:00:00.000Z' }] }));
  for (const day of ['04','11','18']) {
    const batch = db.batch();
    for (let i = 0; i < 400; i++) batch.set(db.doc(`events/p204-budget-${day}-${i}`), { schemaVersion: 2, orgId, facilityId: facility.id, resourceId: resource.id, publicationState: 'staged', status: 'scheduled', startsAt: Timestamp.fromDate(new Date(`2035-11-${day}T23:00:00Z`)), endsAt: Timestamp.fromDate(new Date(`2035-11-${day}T23:30:00Z`)) });
    await batch.commit();
  }
  await assert.rejects(preview(input({ fields: { ...fields, localTime: '17:00', facilityId: facility.id, resourceId: resource.id } })), e => e.code === 'functions/resource-exhausted' && /1,000/.test(e.message));
});
