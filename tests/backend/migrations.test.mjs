import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { projectId, requireEmulators } from './fixtures.mjs';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { buildPlan, applyPlan, checksum, encode, decode, participantId, localInstant } = require('./lib/migrations/legacy.js');
requireEmulators();
let app, db;
const stamp = new Timestamp(1791676800, 123456000);
const manifest = { version: 1, noEmail: true, confirmedAt: '2026-10-11T12:00:00.000Z', mappings: ['mig-a', 'mig-b'].map(teamId => ({ teamId, orgId: 'mig-org', programId: 'soccer', seasonId: 'fall', divisionId: 'u12', timeZone: 'America/Chicago', confirmedBy: 'mig-owner', defaultDurationMinutes: 60 })) };
function fixture() {
  const rows = {
    'organizations/mig-org': { schemaVersion: 2, status: 'active', features: { organizationV2: true } },
    'organizations/mig-org/programs/soccer': { schemaVersion: 2, orgId: 'mig-org', status: 'active' },
    'organizations/mig-org/seasons/fall': { schemaVersion: 2, orgId: 'mig-org', programId: 'soccer', status: 'active' },
    'organizations/mig-org/divisions/u12': { schemaVersion: 2, orgId: 'mig-org', programId: 'soccer', seasonId: 'fall', status: 'active' },
    'users/mig-owner': { displayName: 'Synthetic coach' },
    'users/mig-player': { displayName: 'Synthetic player' },
    'users/mig-other': { displayName: 'Synthetic player' },
    'teams/mig-unmapped': { name: 'Isolated legacy', createdBy: 'mig-owner', inviteCode: 'ZZZZZZZZ' },
    'teamMembers/mig-unmapped_mig-player': { teamId: 'mig-unmapped', userId: 'mig-player', role: 'player', joinedAt: stamp },
    'inviteCodes/ZZZZZZZZ': { teamId: 'mig-unmapped' },
    'events/mig-unmapped-event': { teamId: 'mig-unmapped', createdBy: 'mig-owner', deletedAt: null, date: stamp, time: '12:00' },
  };
  for (const [i, teamId] of ['mig-a', 'mig-b'].entries()) {
    const inviteCode = i === 0 ? 'AAAAAAAA' : 'BBBBBBBB';
    rows[`teams/${teamId}`] = { name: 'Synthetic team', createdBy: 'mig-owner', inviteCode, createdAt: stamp, updatedAt: stamp };
    rows[`inviteCodes/${inviteCode}`] = { teamId, createdAt: stamp };
    for (const [uid, role] of [['mig-player', 'player'], ['mig-other', 'player'], ['mig-owner', 'coach']]) rows[`teamMembers/${teamId}_${uid}`] = { teamId, userId: uid, role, displayName: 'Membership name', joinedAt: stamp };
    rows[`events/${teamId}-event`] = { teamId, createdBy: 'mig-owner', createdAt: stamp, updatedAt: stamp, date: Timestamp.fromDate(new Date('2026-10-11T00:00:00.000Z')), time: '18:30', title: 'Synthetic practice', type: 'practice', deletedAt: i === 0 ? null : stamp, revision: 3 };
  }
  return rows;
}
before(() => { app = initializeApp({ projectId }, 'migration-tests'); db = getFirestore(app); });
after(async () => deleteApp(app));
test('CLI refuses execution outside the isolated emulator before opening a database', () => {
  const result = spawnSync(process.execPath, ['scripts/migrations/legacy.mjs', 'dry-run', '/tmp/missing-manifest.json', '/tmp/missing-plan.json'], { env: { ...process.env, FIRESTORE_EMULATOR_HOST: '', GCLOUD_PROJECT: 'production' }, encoding: 'utf8' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Requires isolated demo project/);
});
test('pure dry-run is deterministic, no-email, org-local and preserves calendar labels/timestamps', () => {
  const inventory = fixture(); const before = checksum(inventory);
  const first = buildPlan(manifest, inventory); const second = buildPlan({ ...manifest, mappings: [...manifest.mappings].reverse() }, Object.fromEntries(Object.entries(inventory).reverse()));
  assert.deepEqual(first, second); assert.equal(checksum(inventory), before);
  assert.deepEqual(first.report.issues, []); assert.deepEqual(first.report.orphanPaths, []);
  assert.deepEqual(first.report.counts, { events: 2, inviteCodes: 2, participants: 2, teamMembers: 6, teams: 2, roster: 4 });
  assert.deepEqual(first.report.unmappedTeamIds, ['mig-unmapped']);
  assert.notEqual(participantId('mig-org', 'mig-player'), participantId('other-org', 'mig-player'));
  assert.notEqual(participantId('mig-org', 'mig-player'), participantId('mig-org', 'mig-other'));
  assert.ok(!first.operations.some(op => op.path.includes('guardians') || op.path.includes('outbox') || op.path.includes('participantLinks')));
  const event = first.operations.find(op => op.path === 'events/mig-a-event').after;
  assert.equal(event.startsAt.toDate().toISOString(), '2026-10-11T23:30:00.000Z');
  assert.equal(event.endsAt.toMillis() - event.startsAt.toMillis(), 3600000);
  assert.equal(event.publicationState, 'staged'); assert.equal(event.revision, 4);
  assert.deepEqual(event.createdAt, stamp); assert.deepEqual(event.date, inventory['events/mig-a-event'].date);
  assert.deepEqual(first.operations.find(op => op.path === 'events/mig-b-event').after.deletedAt, stamp);
  assert.deepEqual(decode(JSON.parse(JSON.stringify(encode(first)))), first);
  assert.deepEqual(decode(encode(new Timestamp(1, 123456789))), new Timestamp(1, 123456789));
});
test('DST gaps/folds, half-hour transitions, invalid zones/dates require explicit review', () => {
  for (const [day, time, zone, message] of [
    ['2026-03-08', '02:30', 'America/Chicago', /Nonexistent/],
    ['2026-11-01', '01:30', 'America/Chicago', /Ambiguous/],
    ['2026-04-05', '01:45', 'Australia/Lord_Howe', /Ambiguous/],
    ['2026-10-04', '02:15', 'Australia/Lord_Howe', /Nonexistent/],
    ['2026-01-01', '12:00', 'Invalid/Zone', /Invalid time zone/],
  ]) assert.throws(() => localInstant(`${day}T00:00:00.000Z`, time, zone), message);
  assert.throws(() => localInstant('2026-02-30T00:00:00.000Z', '12:00', 'UTC'), /Timestamp/);
  assert.equal(localInstant('2026-01-01T00:00:00.000Z', '12:00', 'Asia/Kathmandu').toDate().toISOString(), '2026-01-01T06:15:00.000Z');
});
test('bad mappings, orphans, names, dates, foreign parents, and missing users block apply', async () => {
  for (const mutate of [
    rows => { rows['events/mig-a-event'].time = '25:00'; },
    rows => { rows['events/mig-a-event'].date = 'not-a-date'; },
    rows => { rows['events/mig-a-event'].date = '2026-11-01T00:00:00.000Z'; rows['events/mig-a-event'].time = '01:30'; },
    rows => { rows['organizations/mig-org/divisions/u12'].orgId = 'other-org'; },
    rows => { rows['users/mig-player'].displayName = ''; },
    rows => { delete rows['users/mig-player']; },
    rows => { rows['events/mig-orphan'] = { teamId: 'missing' }; },
    rows => { rows['inviteCodes/AAAAAAAA'].teamId = 'mig-b'; },
    rows => { rows['teamMembers/forged'] = { teamId: 'mig-a', userId: 'mig-player', role: 'coach', joinedAt: stamp }; },
  ]) {
    const rows = fixture(); mutate(rows); const plan = buildPlan(manifest, rows);
    assert.ok(plan.report.issues.length || plan.report.orphanPaths.length);
    await assert.rejects(applyPlan(db, plan, checksum(plan)), /Review blocking/);
  }
  const bad = buildPlan({ ...manifest, mappings: [manifest.mappings[0], manifest.mappings[0]] }, fixture()); assert.ok(bad.report.issues.length);
  const zone = buildPlan({ ...manifest, mappings: [{ ...manifest.mappings[0], timeZone: 'No/Zone' }] }, fixture()); assert.ok(zone.report.issues.length);
  assert.throws(() => buildPlan({ ...manifest, noEmail: false }, fixture()), /noEmail/);
});
test('seeded emulator run resumes, runs twice unchanged, reconciles counts and preserves unmapped access', async () => {
  const inventory = fixture();
  for (const [path, data] of Object.entries(inventory)) await db.doc(path).set(data);
  const plan = buildPlan(manifest, inventory); const digest = checksum(plan);
  await assert.rejects(applyPlan(db, plan, 'wrong'), /checksum/);
  const first = await applyPlan(db, plan, digest, 3); assert.equal(first.complete, false); assert.equal(first.completed, 3);
  const done = await applyPlan(db, plan, digest); assert.equal(done.complete, true); assert.equal(done.completed, plan.operations.length);
  const snapshots = {};
  for (const op of plan.operations) snapshots[op.path] = (await db.doc(op.path).get()).data();
  assert.deepEqual(await applyPlan(db, plan, digest), done);
  for (const op of plan.operations) assert.deepEqual((await db.doc(op.path).get()).data(), snapshots[op.path]);
  assert.equal((await db.collection('organizations/mig-org/participants').get()).size, 2);
  for (const teamId of ['mig-a', 'mig-b']) assert.equal((await db.collection(`teams/${teamId}/roster`).get()).size, 2);
  for (const path of Object.keys(inventory).filter(path => path.includes('mig-unmapped') || path === 'inviteCodes/ZZZZZZZZ')) assert.deepEqual((await db.doc(path).get()).data(), inventory[path]);
  const { initializeApp: clientApp, deleteApp: deleteClient } = await import('firebase/app');
  const { getFirestore: clientDb, connectFirestoreEmulator, getDoc, doc } = await import('firebase/firestore');
  const { getAuth, connectAuthEmulator, signInWithCustomToken } = await import('firebase/auth');
  const { getAuth: adminAuth } = require('firebase-admin/auth');
  const client = clientApp({ projectId, apiKey: 'demo-key' }, 'migration-legacy-reader');
  connectFirestoreEmulator(clientDb(client), '127.0.0.1', 8080); connectAuthEmulator(getAuth(client), 'http://127.0.0.1:9099', { disableWarnings: true });
  await signInWithCustomToken(getAuth(client), await adminAuth(app).createCustomToken('mig-player'));
  assert.equal((await getDoc(doc(clientDb(client), 'teams/mig-unmapped'))).exists(), true);
  assert.equal((await getDoc(doc(clientDb(client), 'events/mig-unmapped-event'))).exists(), true);
  await assert.rejects(getDoc(doc(clientDb(client), 'teams/mig-a')), { code: 'permission-denied' });
  await deleteClient(client);
  await db.doc('events/mig-a-event').update({ title: 'Later edit' });
  await assert.rejects(applyPlan(db, plan, digest), /Completed target changed/);
  await db.doc('events/mig-a-event').set(snapshots['events/mig-a-event']);
  await db.doc('organizations/mig-org/divisions/u12').update({ orgId: 'foreign' });
  await assert.rejects(applyPlan(db, plan, digest), /Dependency changed/);
});
