import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectId, requireEmulators } from './fixtures.mjs';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { collectInventory, checksum, decode, summarize, participantId } = require('./lib/migrations/legacy.js');
requireEmulators();

// Isolated named emulator database so other suites' rows never enter this inventory.
const database = 'migration-live-rehearsal';
const stamp = new Timestamp(1791676800, 123456000);
const day = iso => Timestamp.fromDate(new Date(`${iso}T00:00:00.000Z`));
let app, db, dir;

/** Realistic synthetic legacy dataset: two orgs, three timezones, shared players, coaches, orphans. */
function dataset() {
  const rows = {};
  const orgs = { 'live-org-a': ['soccer', 'fall', 'u12'], 'live-org-b': ['hoops', 'winter', 'u14'] };
  for (const [orgId, [programId, seasonId, divisionId]] of Object.entries(orgs)) {
    rows[`organizations/${orgId}`] = { schemaVersion: 2, status: 'active', features: { organizationV2: true } };
    rows[`organizations/${orgId}/programs/${programId}`] = { schemaVersion: 2, orgId, status: 'active' };
    rows[`organizations/${orgId}/seasons/${seasonId}`] = { schemaVersion: 2, orgId, programId, status: 'active' };
    rows[`organizations/${orgId}/divisions/${divisionId}`] = { schemaVersion: 2, orgId, programId, seasonId, status: 'active' };
  }
  for (const uid of ['coach-1', 'coach-2', 'coach-3', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6']) rows[`users/${uid}`] = { displayName: `Synthetic ${uid}`, email: `${uid}@example.test` };
  const teams = [
    ['live-chi', 'coach-1', 'CHICAGO2', ['p1', 'p2', 'p3'], ['coach-1']],
    ['live-ldn', 'coach-2', 'LONDON22', ['p1', 'p4'], ['coach-2', 'coach-3']],
    ['live-ktm', 'coach-3', 'KATHMAND', ['p5', 'p6'], ['coach-3']],
    ['live-left', 'coach-1', 'LEFTOVER', ['p2'], ['coach-1']],
  ];
  for (const [teamId, owner, inviteCode, players, coaches] of teams) {
    rows[`teams/${teamId}`] = { name: `Synthetic ${teamId}`, createdBy: owner, inviteCode, createdAt: stamp, updatedAt: stamp };
    rows[`inviteCodes/${inviteCode}`] = { teamId, createdAt: stamp };
    for (const uid of players) rows[`teamMembers/${teamId}_${uid}`] = { teamId, userId: uid, role: 'player', joinedAt: stamp };
    for (const uid of coaches) rows[`teamMembers/${teamId}_${uid}`] = { teamId, userId: uid, role: 'coach', joinedAt: stamp };
    for (const [n, time] of ['18:30', '09:15'].entries()) rows[`events/${teamId}-e${n}`] = { teamId, createdBy: owner, createdAt: stamp, updatedAt: stamp, date: day('2026-10-20'), time, title: 'Synthetic practice', type: n ? 'match' : 'practice', deletedAt: null, revision: n };
  }
  // Orphans: an event whose team is gone and a membership whose user is gone.
  rows['events/live-orphan-event'] = { teamId: 'live-deleted-team', createdBy: 'coach-1', date: day('2026-10-20'), time: '10:00' };
  rows['teamMembers/live-chi_ghost'] = { teamId: 'live-chi', userId: 'ghost', role: 'player', joinedAt: stamp };
  return rows;
}
const mapping = (teamId, orgId, programId, seasonId, divisionId, timeZone, defaultDurationMinutes) => ({ teamId, orgId, programId, seasonId, divisionId, timeZone, confirmedBy: 'coach-1', defaultDurationMinutes });
const manifest = { version: 1, noEmail: true, confirmedAt: '2026-10-30T12:00:00.000Z', mappings: [
  mapping('live-chi', 'live-org-a', 'soccer', 'fall', 'u12', 'America/Chicago', 60),
  mapping('live-ldn', 'live-org-a', 'soccer', 'fall', 'u12', 'Europe/London', 90),
  mapping('live-ktm', 'live-org-b', 'hoops', 'winter', 'u14', 'Asia/Kathmandu', 75),
] };

function cli(...args) {
  const env = { ...process.env }; delete env.GOOGLE_APPLICATION_CREDENTIALS;
  return spawnSync(process.execPath, ['scripts/migrations/legacy-live.mjs', ...args], { env, encoding: 'utf8' });
}
const json = result => JSON.parse(result.stdout);
async function snapshotAll() {
  const out = {};
  for (const kind of ['teams', 'teamMembers', 'events', 'inviteCodes', 'users', 'organizations', 'legacyMigrationRuns', 'schedulingLocks']) {
    for (const doc of (await db.collection(kind).get()).docs) out[doc.ref.path] = [doc.data(), doc.updateTime.toMillis()];
  }
  for (const ref of await db.listCollections()) out[`collection:${ref.id}`] = true;
  return checksum(out);
}

before(async () => {
  app = initializeApp({ projectId }, 'migration-live-tests'); db = getFirestore(app, database);
  for (const [path, data] of Object.entries(dataset())) await db.doc(path).set(data);
  dir = mkdtempSync(join(tmpdir(), 'legacy-live-'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
});
after(async () => { rmSync(dir, { recursive: true, force: true }); await deleteApp(app); });

test('refuses missing/non-allowlisted projects and unapproved applies before opening a database', () => {
  const plan = join(dir, 'never.json'); const sum = 'a'.repeat(64);
  for (const [args, message] of [
    [['--dry-run', '--manifest', 'm', '--out', 'o'], /--project is required/],
    [['--project', 'team-hangout-prod', '--dry-run', '--manifest', 'm', '--out', 'o'], /not allowlisted/],
    [['--project', 'demo-team-hangout', '--dry-run', '--apply', '--manifest', 'm', '--out', 'o'], /exactly one/],
    [['--project', 'team-hangout-ddf27', '--apply', '--plan', plan], /approved --checksum/],
    [['--project', 'team-hangout-ddf27', '--apply', '--plan', plan, '--checksum', 'abc'], /64-character/],
    [['--project', 'team-hangout-ddf27', '--apply', '--plan', plan, '--checksum', sum, '--writers-stopped'], /--confirm-project/],
    [['--project', 'team-hangout-staging', '--apply', '--plan', plan, '--checksum', sum, '--confirm-project', 'team-hangout-ddf27', '--writers-stopped'], /--confirm-project/],
    [['--project', 'team-hangout-staging', '--apply', '--plan', plan, '--checksum', sum, '--confirm-project', 'team-hangout-staging'], /--writers-stopped/],
    // The test env carries emulator hosts: a real project must refuse rather than mix targets.
    [['--project', 'team-hangout-staging', '--dry-run', '--manifest', 'm', '--out', 'o'], /Unset emulator hosts/],
    [['--project', 'team-hangout-staging', '--database', 'x', '--dry-run', '--manifest', 'm', '--out', 'o'], /only for isolated emulator/],
  ]) {
    const result = cli(...args);
    assert.equal(result.status, 64, `${args.join(' ')}\n${result.stderr}`); assert.match(result.stderr, message);
  }
});

test('inventory reads only through a read-only transaction', async () => {
  const calls = [];
  const guarded = {
    collection: path => db.collection(path),
    runTransaction: (fn, options) => {
      calls.push(options);
      return db.runTransaction(tx => fn(new Proxy(tx, { get(target, key) {
        if (key !== 'get') throw new Error(`write-capable transaction method used: ${String(key)}`);
        return target.get.bind(target);
      } })), options);
    },
  };
  const before = await snapshotAll();
  const inventory = await collectInventory(guarded);
  assert.deepEqual(calls, [{ readOnly: true }]);
  assert.ok(inventory['teams/live-chi'] && inventory['organizations/live-org-b/divisions/u14']);
  assert.equal(await snapshotAll(), before);
});

test('rehearsal: dry-run, blocking orphans, apply with interruption, resume, replay and access reconciliation', async () => {
  const base = ['--project', projectId, '--database', database];
  // 1. Dry-run reports orphans, writes nothing and blocks apply.
  const untouched = await snapshotAll();
  const blockedPlan = join(dir, 'blocked.json');
  const blocked = cli(...base, '--dry-run', '--manifest', join(dir, 'manifest.json'), '--out', blockedPlan);
  assert.equal(blocked.status, 2, blocked.stderr);
  const blockedSummary = json(blocked).summary;
  assert.equal(blockedSummary.orphanPaths, 2); assert.ok(blockedSummary.blockingIssues >= 1);
  assert.equal(await snapshotAll(), untouched);
  const overwrite = cli(...base, '--dry-run', '--manifest', join(dir, 'manifest.json'), '--out', blockedPlan);
  assert.notEqual(overwrite.status, 0); assert.match(overwrite.stderr, /EEXIST/, 'plan files are created exclusively');
  const blockedSum = json(blocked).checksum;
  const refused = cli(...base, '--apply', '--plan', blockedPlan, '--checksum', blockedSum, '--confirm-project', projectId, '--writers-stopped');
  assert.notEqual(refused.status, 0); assert.match(refused.stderr, /Review blocking/);

  // 2. Operator resolves orphans at source, re-runs dry-run and approves the new checksum.
  await db.doc('events/live-orphan-event').delete(); await db.doc('teamMembers/live-chi_ghost').delete();
  const planPath = join(dir, 'plan.json');
  const dry = cli(...base, '--dry-run', '--manifest', join(dir, 'manifest.json'), '--out', planPath);
  assert.equal(dry.status, 0, dry.stderr);
  const { checksum: approved, summary } = json(dry);
  assert.deepEqual(summary.timeZones, ['America/Chicago', 'Asia/Kathmandu', 'Europe/London']);
  assert.deepEqual(summary.defaultDurationsMinutes, [60, 75, 90]);
  assert.equal(summary.mappedTeams, 3); assert.equal(summary.unmappedTeams, 1);
  assert.equal(summary.coachAssignments, 4); assert.equal(summary.distinctOwners, 3);
  assert.deepEqual(summary.targetCounts, { events: 6, inviteCodes: 3, participants: 6, roster: 7, teamMembers: 11, teams: 3 });
  assert.equal(summary.project, projectId);
  assert.doesNotMatch(dry.stdout, /Synthetic|example\.test|coach-1/, 'console output is aggregate-only');
  const plan = decode(JSON.parse(readFileSync(planPath, 'utf8')));
  assert.equal(checksum(plan), approved); assert.deepEqual(summarize(plan), summary);
  const ktm = plan.operations.find(op => op.path === 'events/live-ktm-e0').after;
  assert.equal(ktm.startsAt.toDate().toISOString(), '2026-10-20T12:45:00.000Z');
  assert.equal(ktm.endsAt.toMillis() - ktm.startsAt.toMillis(), 75 * 60000);

  // 3. Refusals: wrong checksum, wrong project in plan, tampered plan.
  assert.match(cli(...base, '--apply', '--plan', planPath, '--checksum', 'b'.repeat(64), '--confirm-project', projectId, '--writers-stopped').stderr, /checksum mismatch/);
  const tampered = join(dir, 'tampered.json');
  writeFileSync(tampered, readFileSync(planPath, 'utf8').replace('"project": "demo-team-hangout"', '"project": "team-hangout-staging"'));
  assert.match(cli(...base, '--apply', '--plan', tampered, '--checksum', approved, '--confirm-project', projectId, '--writers-stopped').stderr, /different project/);

  // 4. Interrupted apply (simulated crash after 5 writes), then resume to completion.
  const apply = (...extra) => cli(...base, '--apply', '--plan', planPath, '--checksum', approved, '--confirm-project', projectId, '--writers-stopped', ...extra);
  const partial = apply('--max-operations', '5');
  assert.equal(partial.status, 0, partial.stderr);
  assert.deepEqual({ ...json(partial), access: undefined }, { complete: false, completed: 5, expected: plan.operations.length, access: undefined });
  const resumed = apply();
  assert.equal(resumed.status, 0, resumed.stderr);
  const done = json(resumed);
  assert.equal(done.complete, true); assert.equal(done.completed, plan.operations.length);
  assert.deepEqual(done.access, { ok: true, members: 11, coaches: 4, players: 7, mismatches: 0 });

  // 5. Replay is idempotent: same result, no rewrites.
  const targetTimes = async () => Promise.all(plan.operations.map(async op => (await db.doc(op.path).get()).updateTime.toMillis()));
  const settled = await targetTimes();
  const replay = apply();
  assert.equal(replay.status, 0, replay.stderr); assert.deepEqual(json(replay), done);
  const afterReplay = {};
  for (const op of plan.operations) afterReplay[op.path] = (await db.doc(op.path).get()).data();
  for (const op of plan.operations) assert.deepEqual(afterReplay[op.path], op.after);
  assert.equal((await db.doc('teams/live-left').get()).data().orgId, undefined, 'unmapped team untouched');
  assert.deepEqual(await targetTimes(), settled, 'replay rewrites no target');
  const pid = participantId('live-org-a', 'p1');
  assert.equal((await db.collection('organizations/live-org-a/participants').get()).size, 4);
  assert.equal((await db.doc(`teams/live-ldn/roster/${pid}`).get()).data().status, 'active');

  // 6. Access reconciliation detects a membership added after approval.
  await db.doc('teamMembers/live-ktm_p1').set({ teamId: 'live-ktm', userId: 'p1', role: 'player', joinedAt: stamp });
  const drift = cli(...base, '--reconcile', '--plan', planPath, '--checksum', approved);
  assert.equal(drift.status, 3, drift.stderr);
  assert.deepEqual(json(drift).mismatches, [{ path: 'teamMembers/live-ktm_p1', reason: 'Membership not in approved plan' }]);
  await db.doc('teamMembers/live-ktm_p1').delete();

  // 7. A planned player promoted to coach after approval is not accepted from live fields.
  const promoted = db.doc('teamMembers/live-ldn_p1');
  const approvedPlayer = (await promoted.get()).data();
  await promoted.update({ role: 'coach', roles: ['coach'] });
  const promotion = cli(...base, '--reconcile', '--plan', planPath, '--checksum', approved);
  assert.equal(promotion.status, 3, promotion.stderr);
  assert.deepEqual(json(promotion).mismatches, [{ path: 'teamMembers/live-ldn_p1', reason: 'Membership identity or role differs from approved plan' }]);

  // 8. A planned membership deleted after migration is reported missing, not silently dropped from the count.
  await promoted.delete();
  const removal = cli(...base, '--reconcile', '--plan', planPath, '--checksum', approved);
  assert.equal(removal.status, 3, removal.stderr);
  assert.deepEqual(json(removal).mismatches, [{ path: 'teamMembers/live-ldn_p1', reason: 'Planned membership missing' }]);
  await promoted.set(approvedPlayer);
  const restored = cli(...base, '--reconcile', '--plan', planPath, '--checksum', approved);
  assert.equal(restored.status, 0, restored.stderr);
});
