import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from 'firebase/auth';
import { getFunctions, connectFunctionsEmulator, httpsCallable } from 'firebase/functions';
import { getFirestore as clientDb, connectFirestoreEmulator, doc, getDoc, setDoc, collection, query, where, getDocs } from 'firebase/firestore';
import { projectId, requireEmulators, operationalEventFields as fields } from './fixtures.mjs';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp: adminApp, deleteApp: deleteAdmin } = require('firebase-admin/app');
const { getAuth: adminAuth } = require('firebase-admin/auth');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
requireEmulators();
let admin, db, seq = 0; const apps = {};
const call = async (uid, name, data = {}) => (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const req = payload => ({ requestId: `p202-${++seq}`, ...payload });
const deny = promise => assert.rejects(promise, { code: 'functions/permission-denied' });
const scope = { orgId: 'p202-org', programId: 'p202-program', seasonId: 'p202-season', divisionId: 'p202-division' };
const meta = { schemaVersion: 2, revision: 1, status: 'active', createdAt: Timestamp.now(), updatedAt: Timestamp.now() };
async function create(extra = {}) {
  return call('p202-admin', 'createEvent', req({ teamId: 'p202-a', event: { ...fields, title: 'Falcons vs Comets', type: 'match', teamIds: ['p202-a', 'p202-b'], publicationState: 'published', ...extra } }));
}
const mutate = (event, action, patch = {}, extra = {}) => call('p202-admin', 'mutateEventSchedule', req({ eventId: event.id, expectedRevision: event.revision, action, patch, reason: 'Synthetic scheduling change', ...extra }));
before(async () => {
  admin = adminApp({ projectId }); db = getFirestore(admin);
  for (const uid of ['p202-admin', 'p202-a-coach', 'p202-b-coach', 'p202-guardian', 'p202-self', 'p202-outsider', 'p202-support', 'p202-captain']) {
    const app = initializeApp({ projectId, apiKey: 'demo-key' }, uid); apps[uid] = app;
    connectAuthEmulator(getAuth(app), 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), '127.0.0.1', 5001);
    connectFirestoreEmulator(clientDb(app), '127.0.0.1', 8080);
    await adminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password: 'SyntheticPassword123!' });
    await db.doc(`users/${uid}`).set({ uid, appRole: uid === 'p202-support' ? 'superAdmin' : 'user' });
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, 'SyntheticPassword123!');
  }
  await db.doc('organizations/p202-org').set({ ...meta, name: 'Synthetic league', features: { organizationV2: true, households: true } });
  for (const [kind, name] of [['programs', 'p202-program'], ['seasons', 'p202-season'], ['divisions', 'p202-division']]) await db.doc(`organizations/p202-org/${kind}/${name}`).set({ ...meta, ...scope, name });
  await db.doc('organizations/p202-org/members/p202-admin').set({ ...meta, orgId: 'p202-org', roles: ['orgAdmin'], programIds: [] });
  for (const [teamId, name, uid] of [['p202-a', 'Falcons', 'p202-a-coach'], ['p202-b', 'Comets', 'p202-b-coach']]) {
    await db.doc(`teams/${teamId}`).set({ ...meta, ...scope, name });
    await db.doc(`teamMembers/${teamId}_${uid}`).set({ ...meta, orgId: 'p202-org', teamId, userId: uid, role: 'coach', roles: ['coach'] });
  }
  await db.doc('organizations/p202-org/participants/p202-child').set({ ...meta, orgId: 'p202-org', displayName: 'Synthetic child', linkedUserId: 'p202-self' });
  await db.doc('organizations/p202-org/participants/p202-child/guardians/p202-guardian').set({ ...meta, orgId: 'p202-org', participantId: 'p202-child', userId: 'p202-guardian', permissions: { viewSchedule: true, respond: false } });
  await db.doc('teams/p202-b/roster/p202-child').set({ ...meta, orgId: 'p202-org', participantId: 'p202-child' });
});
after(async () => { await Promise.all(Object.values(apps).map(deleteApp)); await deleteAdmin(admin); });
test('one canonical match is visible from either team and live household grants, but only every-team management can mutate', async () => {
  const event = await create();
  assert.equal(event.homeTeamId, 'p202-a'); assert.equal(event.awayTeamId, 'p202-b');
  for (const [uid, teamId] of [['p202-a-coach', 'p202-a'], ['p202-b-coach', 'p202-b'], ['p202-guardian', 'p202-b'], ['p202-self', 'p202-b']]) {
    const rows = await call(uid, 'listCanonicalTeamEvents', { teamId });
    assert.ok(rows.items.some(row => row.id === event.id));
    const loaded = await call(uid, 'getCanonicalEvent', { eventId: event.id });
    assert.equal(loaded.canManage, false); assert.equal(loaded.teams.length, 2);
    await deny(call(uid, 'mutateEventSchedule', req({ eventId: event.id, expectedRevision: 1, action: 'cancel', reason: 'Bad' })));
  }
  for (const uid of ['p202-outsider', 'p202-support', 'p202-captain']) {
    await deny(call(uid, 'getCanonicalEvent', { eventId: event.id }));
    await deny(call(uid, 'getNativeTeam', { teamId: 'p202-a' }));
  }
  const choices = await call('p202-admin', 'listEventTeamChoices', { teamId: 'p202-a' });
  assert.deepEqual(choices.items.map(row => row.id), ['p202-a', 'p202-b']);
  assert.deepEqual((await call('p202-a-coach', 'listEventTeamChoices', { teamId: 'p202-a' })).items.map(row => row.id), ['p202-a']);
  await db.doc('organizations/p202-org/participants/p202-child/guardians/p202-guardian').update({ status: 'revoked' });
  await deny(call('p202-guardian', 'getCanonicalEvent', { eventId: event.id }));
  await db.doc('teams/p202-b/roster/p202-child').update({ status: 'removed' });
  await deny(call('p202-self', 'getCanonicalEvent', { eventId: event.id }));
});
test('staging and every non-null operation remain invisible and client rules cannot expose canonical events', async () => {
  const staged = await create({ publicationState: 'staged' });
  await deny(call('p202-admin', 'getCanonicalEvent', { eventId: staged.id }));
  await assert.rejects(mutate(staged, 'cancel'), { code: 'functions/failed-precondition' });
  const event = await create();
  for (const state of ['running', 'committed']) {
    await db.doc('organizations/p202-org/scheduleOperations/p202-bulk').set({ state });
    await db.doc(`events/${event.id}`).update({ publicationOperationId: 'p202-bulk' });
    await deny(call('p202-admin', 'getCanonicalEvent', { eventId: event.id }));
    assert.ok(!(await call('p202-admin', 'listCanonicalTeamEvents', { teamId: 'p202-a' })).items.some(row => row.id === event.id));
    await assert.rejects(mutate(event, 'edit', { title: 'Cannot clear marker' }), { code: 'functions/invalid-argument' });
  }
  await assert.rejects(getDoc(doc(clientDb(apps['p202-admin']), 'events', event.id)), { code: 'permission-denied' });
  await assert.rejects(setDoc(doc(clientDb(apps['p202-admin']), 'events', event.id), { publicationOperationId: null }, { merge: true }), { code: 'permission-denied' });
});
test('postpone, reschedule, cancellation and completion preserve identity, history and distinct lifecycle', async () => {
  const event = await create();
  const postpone = await mutate(event, 'postpone');
  let stored = (await db.doc(`events/${event.id}`).get()).data();
  assert.equal(stored.status, 'postponed'); assert.equal(stored.deletedAt, null); assert.equal(stored.scheduleVersion, 1);
  const interval = { startsAt: '2026-10-21T23:00:00.000Z', endsAt: '2026-10-22T00:00:00.000Z', timeZone: 'America/Chicago' };
  const moved = await mutate(postpone, 'reschedule', interval);
  stored = (await db.doc(`events/${event.id}`).get()).data();
  assert.equal(moved.id, event.id); assert.equal(stored.status, 'scheduled'); assert.equal(stored.scheduleVersion, 2);
  assert.equal(stored.rescheduledFromRevision, 2); assert.equal(stored.originalInterval.startsAt.toDate().toISOString(), fields.startsAt);
  await mutate(moved, 'cancel');
  stored = (await db.doc(`events/${event.id}`).get()).data(); assert.equal(stored.status, 'cancelled'); assert.equal(stored.deletedAt, null);
  const loaded = await call('p202-b-coach', 'getCanonicalEvent', { eventId: event.id });
  assert.deepEqual(loaded.history.map(row => row.action), ['cancel', 'reschedule', 'postpone']);
  await assert.rejects(mutate({ id: event.id, revision: 4 }, 'reschedule', interval), { code: 'functions/failed-precondition' });
  const complete = await create(); await mutate(complete, 'complete');
  assert.equal((await db.doc(`events/${complete.id}`).get()).data().status, 'completed');
  assert.equal((await db.collection(`events/${complete.id}/attendance`).get()).size, 0);
});
test('revision concurrency, idempotency, immutable references, revoked replay and deleting accounts fail closed', async () => {
  const event = await create();
  const payload = req({ eventId: event.id, expectedRevision: 1, action: 'edit', patch: { title: 'Updated' }, reason: 'Title correction' });
  const [a, b] = await Promise.all([call('p202-admin', 'mutateEventSchedule', payload), call('p202-admin', 'mutateEventSchedule', payload)]);
  assert.deepEqual(a, b); assert.equal((await db.collection(`events/${event.id}/scheduleHistory`).get()).size, 1);
  await assert.rejects(call('p202-admin', 'mutateEventSchedule', { ...payload, reason: 'Changed' }), error => error.details.domainCode === 'REQUEST_ID_REUSED');
  await assert.rejects(mutate(event, 'cancel'), error => error.details.domainCode === 'STALE_REVISION');
  for (const patch of [{ teamIds: ['foreign'] }, { orgId: 'foreign' }, { publicationOperationId: null }, { startsAt: fields.startsAt }]) {
    await assert.rejects(mutate(a, 'edit', patch), { code: 'functions/invalid-argument' });
  }
  const concurrent = await Promise.allSettled(['One', 'Two'].map(title => mutate(a, 'edit', { title })));
  assert.equal(concurrent.filter(row => row.status === 'fulfilled').length, 1);
  await db.doc('organizations/p202-org/members/p202-admin').update({ status: 'revoked' });
  await deny(call('p202-admin', 'mutateEventSchedule', payload));
  await db.doc('organizations/p202-org/members/p202-admin').update({ status: 'active' });
  await db.doc('accountDeletionJobs/p202-admin').set({ status: 'pending' });
  await assert.rejects(call('p202-admin', 'mutateEventSchedule', payload));
  await db.doc('accountDeletionJobs/p202-admin').delete();
});
test('native creation reads the canonical organization timezone instead of team or device defaults', async () => {
  await db.doc('organizations/p202-org').update({ timeZone: 'America/Phoenix' });
  await db.doc('teams/p202-a').update({ timeZone: 'America/New_York' });
  assert.equal((await call('p202-admin', 'getNativeTeam', { teamId: 'p202-a' })).timeZone, 'America/Phoenix');
  await db.doc('organizations/p202-org').update({ timeZone: 'America/Chicago' });
  assert.equal((await call('p202-admin', 'getNativeTeam', { teamId: 'p202-a' })).timeZone, 'America/Chicago');
});
test('50-event reads reuse transaction-local grants and metadata, then reauthorize the next request', async () => {
  await db.doc('organizations/p202-org/participants/p202-child/guardians/p202-guardian').update({ status: 'active' });
  await db.doc('teams/p202-b/roster/p202-child').update({ status: 'active' });
  const batch = db.batch();
  for (let i = 0; i < 50; i++) batch.set(db.doc(`events/p202-page-${i}`), { ...meta, ...scope,
    title: `Synthetic batch match ${i}`, type: 'match', teamId: 'p202-a', teamIds: ['p202-a', 'p202-b'],
    startsAt: Timestamp.fromDate(new Date(fields.startsAt)), endsAt: Timestamp.fromDate(new Date(fields.endsAt)),
    timeZone: 'America/Chicago', status: 'scheduled', publicationState: 'published', publicationOperationId: null,
    createdBy: 'p202-admin', updatedBy: 'p202-admin', deletedAt: null });
  await batch.commit();
  const { listCanonicalTeamEvents } = require('./lib/operations/events.js');
  const transact = db.runTransaction.bind(db);
  const counts = new Map();
  const count = ref => counts.set(ref.path, (counts.get(ref.path) ?? 0) + 1);
  db.runTransaction = (callback, options) => transact(tx => callback(new Proxy(tx, { get(target, name) {
    if (name === 'getAll') return (...refs) => { refs.forEach(count); return target.getAll(...refs); };
    if (name === 'get') return ref => { if (typeof ref.collection === 'function') count(ref); return target.get(ref); };
    const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
  } })), options);
  let page;
  try { page = await listCanonicalTeamEvents.run({ data: { teamId: 'p202-b', pageSize: 50 }, auth: { uid: 'p202-guardian' } }); }
  finally { db.runTransaction = transact; }
  assert.equal(page.items.length, 50); assert.ok(page.items.every(item => item.canManage === false));
  for (const [path, count] of counts) assert.equal(count, 1, `Repeated document read: ${path}`);
  assert.ok(counts.size < 30, `Expected bounded shared metadata reads, got ${counts.size}`);
  await db.doc('organizations/p202-org/participants/p202-child/guardians/p202-guardian').update({ status: 'revoked' });
  await deny(call('p202-guardian', 'listCanonicalTeamEvents', { teamId: 'p202-b', pageSize: 50 }));
});
test('legacy update cannot bypass published history, but single-event draft promotion still replays safely', async () => {
  const event = await create();
  for (const patch of [{ title: 'Bypass' }, { type: 'practice' }, { location: { name: 'Changed' } }, { notes: 'Changed' }]) {
    await assert.rejects(call('p202-admin', 'updateEvent', req({ eventId: event.id, expectedRevision: 1, patch })),
      error => error.code === 'functions/failed-precondition' && error.details.domainCode === 'LIFECYCLE_COMMAND_REQUIRED');
  }
  assert.equal((await db.doc(`events/${event.id}`).get()).data().revision, 1);
  assert.equal((await db.collection(`events/${event.id}/scheduleHistory`).get()).size, 0);
  await mutate(event, 'edit', { title: 'Audited correction' });
  assert.equal((await db.collection(`events/${event.id}/scheduleHistory`).get()).size, 1);
  const staged = await create({ publicationState: 'staged' });
  const promotion = req({ eventId: staged.id, expectedRevision: 1, patch: { publicationState: 'published', title: 'Reviewed single-event publication' } });
  const first = await call('p202-admin', 'updateEvent', promotion);
  assert.deepEqual(await call('p202-admin', 'updateEvent', promotion), first);
  assert.equal((await db.doc(`events/${staged.id}`).get()).data().revision, 2);
  assert.equal((await call('p202-admin', 'getCanonicalEvent', { eventId: staged.id })).publicationOperationId, null);
});
test('recent history uses an extra row to distinguish 19, exactly 20, and 21 records', async () => {
  let event = await create();
  for (let i = 1; i <= 21; i++) {
    event = await mutate(event, 'edit', { title: `History edit ${i}` });
    if (i >= 19) {
      const loaded = await call('p202-admin', 'getCanonicalEvent', { eventId: event.id });
      assert.equal(loaded.history.length, Math.min(i, 20));
      assert.equal(loaded.historyHasMore, i > 20);
      assert.equal(loaded.history[0].revision, i + 1);
      assert.equal(loaded.history.at(-1).revision, i > 20 ? 3 : 2);
    }
  }
});


test('captain-only grants manage canonical events only with live authority for every participating team', async () => {
  const uid = 'p202-captain';
  const grant = teamId => ({ ...meta, orgId: 'p202-org', teamId, userId: uid, roles: ['captain'] });
  await db.doc(`teamMembers/p202-a_${uid}`).set(grant('p202-a'));
  assert.deepEqual((await call(uid, 'listEventTeamChoices', { teamId: 'p202-a' })).items.map(row => row.id), ['p202-a']);
  const shared = await create();
  assert.equal((await call(uid, 'getCanonicalEvent', { eventId: shared.id })).canManage, false);
  const payload = req({ eventId: shared.id, expectedRevision: 1, action: 'edit', patch: { title: 'Captain correction' }, reason: 'Fixture change' });
  await deny(call(uid, 'mutateEventSchedule', payload));
  await deny(call(uid, 'createEvent', req({ teamId: 'p202-a', event: { ...fields, teamIds: ['p202-a', 'p202-b'], publicationState: 'published' } })));
  await db.doc(`teamMembers/p202-b_${uid}`).set(grant('p202-b'));
  assert.equal((await call(uid, 'getCanonicalEvent', { eventId: shared.id })).canManage, true);
  assert.deepEqual((await call(uid, 'listEventTeamChoices', { teamId: 'p202-a' })).items.map(row => row.id), ['p202-a', 'p202-b']);
  const created = await call(uid, 'createEvent', req({ teamId: 'p202-a', event: { ...fields, teamIds: ['p202-a', 'p202-b'], publicationState: 'published' } }));
  const edited = await call(uid, 'mutateEventSchedule', payload);
  const change = (event, action, patch = {}) => call(uid, 'mutateEventSchedule', req({ eventId: event.id, expectedRevision: event.revision, action, patch, reason: 'Captain schedule change' }));
  const postponed = await change(edited, 'postpone');
  const moved = await change(postponed, 'reschedule', { startsAt: '2026-10-21T23:00:00.000Z', endsAt: '2026-10-22T00:00:00.000Z', timeZone: fields.timeZone });
  await change(moved, 'cancel');
  await change(created, 'complete');
  await db.doc(`teamMembers/p202-b_${uid}`).update({ status: 'revoked' });
  assert.equal((await call(uid, 'getCanonicalEvent', { eventId: shared.id })).canManage, false);
  await deny(call(uid, 'mutateEventSchedule', payload));
  await db.doc(`teamMembers/p202-b_${uid}`).update({ status: 'active', orgId: 'foreign' });
  await deny(call(uid, 'mutateEventSchedule', payload));
});


test('canonical team navigation never grants legacy directory access and live team reads reject revoked assignments', async () => {
  const uid = 'p202-outsider';
  for (const [teamId, status] of [['p202-a', 'revoked'], ['p202-b', 'active']]) {
    await db.doc(`teamMembers/${teamId}_${uid}`).set({ ...meta, orgId: 'p202-org', teamId, userId: uid, roles: ['coach'], status });
  }
  const memberships = await getDocs(query(collection(clientDb(apps[uid]), 'teamMembers'), where('userId', '==', uid)));
  assert.equal(memberships.size, 2); // Self-owned revoked assignments remain readable, so native discovery must filter them.
  await deny(call(uid, 'getNativeTeam', { teamId: 'p202-a' }));
  assert.equal((await call(uid, 'getNativeTeam', { teamId: 'p202-b' })).name, 'Comets');
  for (const actor of [uid, 'p202-b-coach', 'p202-guardian', 'p202-admin']) {
    await assert.rejects(getDocs(query(collection(clientDb(apps[actor]), 'teamMembers'), where('teamId', '==', 'p202-b'))), { code: 'permission-denied' });
  }
  await db.doc(`teamMembers/p202-b_${uid}`).update({ status: 'revoked' });
  await deny(call(uid, 'getNativeTeam', { teamId: 'p202-b' }));
});
