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
test('staging and malformed operation markers remain invisible and client rules cannot expose canonical events', async () => {
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

test('family event and team responses exclude private notes, audit identities and unlisted metadata', async () => {
  await db.doc('organizations/p202-org/participants/p202-child/guardians/p202-guardian').update({ status: 'active' });
  await db.doc('teams/p202-b/roster/p202-child').update({ status: 'active' });
  await db.doc('teams/p202-b').update({ externalId: 'internal-import-key', createdBy: 'private-team-creator', updatedBy: 'private-team-editor', futurePrivateField: 'secret' });
  const event = await create({ notes: 'Staff-only instructions', startsAt: '2026-10-01T18:00:00.000Z', endsAt: '2026-10-01T19:00:00.000Z' });
  for (const uid of ['p202-guardian', 'p202-self']) {
    const loaded = await call(uid, 'getCanonicalEvent', { eventId: event.id });
    for (const key of ['notes', 'createdBy', 'updatedBy']) assert.equal(Object.hasOwn(loaded, key), false, `${uid}: ${key}`);
    const page = await call(uid, 'listCanonicalTeamEvents', { teamId: 'p202-b', pageSize: 50 });
    assert.ok(page.items.some(row => row.id === event.id));
    for (const row of page.items) for (const key of ['notes', 'createdBy', 'updatedBy']) assert.equal(Object.hasOwn(row, key), false);
    const team = await call(uid, 'getNativeTeam', { teamId: 'p202-b' });
    assert.deepEqual(Object.keys(team).sort(), ['id', 'schemaVersion', 'name', 'sport', 'timeZone'].sort());
    assert.equal(team.name, 'Comets'); assert.equal(team.timeZone, 'America/Chicago');
  }
  for (const uid of ['p202-admin', 'p202-a-coach', 'p202-b-coach']) {
    const loaded = await call(uid, 'getCanonicalEvent', { eventId: event.id });
    assert.equal(loaded.notes, 'Staff-only instructions'); assert.equal(loaded.createdBy, 'p202-admin');
  }
  const ref = db.doc('teamMembers/p202-b_p202-guardian');
  await ref.set({ ...meta, orgId: 'p202-org', teamId: 'p202-b', userId: 'p202-guardian', roles: ['coach'] });
  assert.equal((await call('p202-guardian', 'getCanonicalEvent', { eventId: event.id })).notes, 'Staff-only instructions');
  await ref.update({ status: 'revoked' });
  const publicAgain = await call('p202-guardian', 'getCanonicalEvent', { eventId: event.id });
  assert.equal(Object.hasOwn(publicAgain, 'notes'), false); assert.equal(Object.hasOwn(publicAgain, 'createdBy'), false);
});

test('staged type edits recompute matchup IDs before promotion', async () => {
  const staged = await create({ publicationState: 'staged' });
  let revision = 1;
  for (const type of ['practice', 'match']) {
    const updated = await call('p202-admin', 'updateEvent', req({ eventId: staged.id, expectedRevision: revision, patch: { type } }));
    revision = updated.revision;
    const stored = (await db.doc(`events/${staged.id}`).get()).data();
    assert.equal(stored.homeTeamId, type === 'match' ? 'p202-a' : null);
    assert.equal(stored.awayTeamId, type === 'match' ? 'p202-b' : null);
  }
  await call('p202-admin', 'updateEvent', req({ eventId: staged.id, expectedRevision: revision, patch: { publicationState: 'published' } }));
  const loaded = await call('p202-admin', 'getCanonicalEvent', { eventId: staged.id });
  assert.equal(loaded.homeTeamId, 'p202-a'); assert.equal(loaded.awayTeamId, 'p202-b');
});

test('canonical event pages order by instant and retain equal-instant boundaries without duplicates', async () => {
  const teamId = 'p202-ordered';
  await db.doc(`teams/${teamId}`).set({ ...meta, ...scope, name: 'Ordered team' });
  for (const [id, instant] of [['p202-z-early', '2026-11-01T05:45:00.000Z'], ['p202-a-later', '2026-11-01T06:15:00.000Z'], ['p202-b-tie', '2026-11-01T06:15:00.000Z'], ['p202-c-last', '2026-11-01T08:00:00.000Z']]) {
    await db.doc(`events/${id}`).set({ ...meta, ...scope, teamId, teamIds: [teamId], title: id, type: 'practice',
      startsAt: Timestamp.fromDate(new Date(instant)), endsAt: Timestamp.fromDate(new Date(Date.parse(instant) + 3600000)),
      timeZone: 'America/New_York', publicationState: 'published', publicationOperationId: null, deletedAt: null,
      createdBy: 'p202-admin', updatedBy: 'p202-admin' });
  }
  const first = await call('p202-admin', 'listCanonicalTeamEvents', { teamId, pageSize: 2 });
  assert.deepEqual(first.items.map(row => row.id), ['p202-z-early', 'p202-a-later']);
  // Moving the boundary after the first page must not move its original cursor position.
  await db.doc('events/p202-a-later').update({ startsAt: Timestamp.fromDate(new Date('2026-11-02T06:15:00.000Z')), endsAt: Timestamp.fromDate(new Date('2026-11-02T07:15:00.000Z')) });
  const second = await call('p202-admin', 'listCanonicalTeamEvents', { teamId, pageSize: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(row => row.id), ['p202-b-tie', 'p202-c-last']);
  assert.notEqual(second.nextCursor, null);
  const third = await call('p202-admin', 'listCanonicalTeamEvents', { teamId, pageSize: 2, cursor: second.nextCursor });
  assert.deepEqual(third.items.map(row => row.id), ['p202-a-later']);
  assert.equal(third.nextCursor, null);
  await assert.rejects(call('p202-admin', 'listCanonicalTeamEvents', { teamId, cursor: 'invalid' }), { code: 'functions/invalid-argument' });
  await assert.rejects(call('p202-admin', 'listCanonicalTeamEvents', { teamId: 'p202-a', pageSize: 2, cursor: first.nextCursor }), { code: 'functions/invalid-argument' });
});


test('opponent choices expose bounded pages and recheck authority for every request', async () => {
  const batch = db.batch();
  for (let i = 0; i < 55; i++) batch.set(db.doc(`teams/p202-choice-${String(i).padStart(2, '0')}`), { ...meta, ...scope, name: `Choice ${i}` });
  await batch.commit();
  const first = await call('p202-admin', 'listEventTeamChoices', { teamId: 'p202-a', pageSize: 50 });
  assert.equal(first.items.length, 50); assert.ok(first.nextCursor);
  const second = await call('p202-admin', 'listEventTeamChoices', { teamId: 'p202-a', pageSize: 50, cursor: first.nextCursor });
  assert.ok(second.items.length > 0); assert.equal(second.nextCursor, null);
  const ids = [...first.items, ...second.items].map(row => row.id);
  assert.equal(new Set(ids).size, ids.length);
  const coachPage = await call('p202-a-coach', 'listEventTeamChoices', { teamId: 'p202-a', pageSize: 50 });
  assert.deepEqual(coachPage.items.map(row => row.id), ['p202-a']); assert.ok(coachPage.nextCursor);
  await db.doc('teamMembers/p202-a_p202-a-coach').update({ status: 'revoked' });
  await deny(call('p202-a-coach', 'listEventTeamChoices', { teamId: 'p202-a', cursor: coachPage.nextCursor }));
});


test('published soft deletion requires cancellation history while staged deletion stays compatible', async () => {
  const event = await create();
  await assert.rejects(call('p202-admin', 'softDeleteEvent', req({ eventId: event.id, expectedRevision: 1 })), error => error.details.domainCode === 'LIFECYCLE_COMMAND_REQUIRED');
  assert.equal((await db.doc(`events/${event.id}`).get()).data().deletedAt, null);
  assert.equal((await db.doc(`events/${event.id}`).get()).data().revision, 1);
  const cancelled = await mutate(event, 'cancel');
  assert.equal(cancelled.revision, 2);
  assert.equal((await db.doc(`events/${event.id}/scheduleHistory/2`).get()).data().action, 'cancel');
  const staged = await create({ publicationState: 'staged' });
  const deletion = req({ eventId: staged.id, expectedRevision: 1 });
  assert.deepEqual(await call('p202-admin', 'softDeleteEvent', deletion), await call('p202-admin', 'softDeleteEvent', deletion));
  assert.ok((await db.doc(`events/${staged.id}`).get()).data().deletedAt);
});

test('family history excludes staff freeform reasons and keeps safe lifecycle timing', async () => {
  const agendaEvent = async (uid, eventId) => {
    let cursor;
    do {
      const page = await call(uid, 'listHouseholdAgenda', { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z', ...(cursor ? { cursor } : {}) });
      const row = page.items.find(item => item.id === eventId);
      if (row) return row;
      cursor = page.nextCursor;
    } while (cursor);
    assert.fail('Expected lifecycle event in the complete authorized agenda.');
  };
  const event = await create();
  const edited = await mutate(event, 'edit', { notes: 'Private staff note' }, { reason: 'Private note explanation' });
  const postponed = await mutate(edited, 'postpone', {}, { reason: 'Private freeform scheduling explanation' });
  await db.doc(`events/${event.id}/scheduleHistory/3`).update({ privateFutureField: 'secret', actorUid: 'staff' });
  for (const uid of ['p202-guardian', 'p202-self']) {
    const loaded = await call(uid, 'getCanonicalEvent', { eventId: event.id });
    assert.deepEqual(loaded.history.map(row => row.action), ['postpone', 'edit']);
    for (const row of loaded.history) for (const key of ['reason', 'actorUid', 'privateFutureField']) assert.equal(Object.hasOwn(row, key), false);
    assert.ok(loaded.history[0].previousStartsAt); assert.equal(loaded.status, 'postponed');
    assert.equal((await agendaEvent(uid, event.id)).status, 'postponed');
  }
  assert.equal((await call('p202-admin', 'getCanonicalEvent', { eventId: event.id })).history[0].reason, 'Private freeform scheduling explanation');
  await mutate(postponed, 'cancel');
  assert.equal((await agendaEvent('p202-guardian', event.id)).status, 'cancelled');
});

test('native upcoming pages bypass a large archive and past pages remain available', async () => {
  const teamId = 'p202-current';
  await db.doc(`teams/${teamId}`).set({ ...meta, ...scope, name: 'Current schedule' });
  const batch = db.batch();
  const now = Date.now();
  for (let i = 0; i < 60; i++) batch.set(db.doc(`events/p202-old-${i}`), { ...meta, ...scope, teamId, teamIds: [teamId],
    title: `Old ${i}`, type: 'practice', startsAt: Timestamp.fromMillis(now - (i + 1) * 86400000), endsAt: Timestamp.fromMillis(now - (i + 1) * 86400000 + 3600000),
    timeZone: 'America/Chicago', status: 'completed', publicationState: 'published', publicationOperationId: null, deletedAt: null });
  batch.set(db.doc('events/p202-next'), { ...meta, ...scope, teamId, teamIds: [teamId], title: 'Next practice', type: 'practice',
    startsAt: Timestamp.fromMillis(now + 86400000), endsAt: Timestamp.fromMillis(now + 90000000), timeZone: 'America/Chicago', status: 'scheduled', publicationState: 'published', publicationOperationId: null, deletedAt: null });
  await batch.commit();
  const upcoming = await call('p202-admin', 'listCanonicalTeamEvents', { teamId, view: 'upcoming' });
  assert.deepEqual(upcoming.items.map(row => row.id), ['p202-next']); assert.equal(upcoming.nextCursor, null);
  const past = await call('p202-admin', 'listCanonicalTeamEvents', { teamId, view: 'past' });
  assert.equal(past.items.length, 50); assert.equal(past.items[0].id, 'p202-old-0'); assert.ok(past.nextCursor);
  const older = await call('p202-admin', 'listCanonicalTeamEvents', { teamId, view: 'past', cursor: past.nextCursor });
  assert.equal(older.items.length, 10); assert.equal(older.nextCursor, null);
  await assert.rejects(call('p202-admin', 'listCanonicalTeamEvents', { teamId, view: 'upcoming', cursor: past.nextCursor }), { code: 'functions/invalid-argument' });
});


test('schedule page management uses live grants even when revoked managers retain household access', async () => {
  const uid = 'p202-guardian', teamId = 'p202-b';
  const ref = db.doc(`teamMembers/${teamId}_${uid}`);
  await db.doc('organizations/p202-org/participants/p202-child/guardians/p202-guardian').update({ status: 'active' });
  await db.doc('teams/p202-b/roster/p202-child').update({ status: 'active' });
  await ref.set({ ...meta, orgId: 'p202-org', teamId, userId: uid, roles: ['captain'] });
  assert.equal((await call(uid, 'listCanonicalTeamEvents', { teamId })).canManage, true);
  await ref.update({ status: 'revoked' });
  await db.doc(`users/${uid}`).update({ appRole: 'superAdmin' });
  assert.equal((await call(uid, 'listCanonicalTeamEvents', { teamId })).canManage, false);
  await deny(call(uid, 'createEvent', req({ teamId, event: { ...fields, teamIds: [teamId], publicationState: 'published' } })));
  await db.doc(`users/${uid}`).update({ appRole: 'user' });
});
