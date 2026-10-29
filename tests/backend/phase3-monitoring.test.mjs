import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { projectId, requireEmulators } from './fixtures.mjs';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const logger = require('firebase-functions/logger');
const { monitorPhase3Pilot, phase3AlertSummaries, collectPhase3Alerts, PHASE3_STUCK_AFTER_MS } = require('./lib/operations/phase3Monitoring.js');
requireEmulators();
const hub = `http://${process.env.FIREBASE_EMULATOR_HUB ?? '127.0.0.1:4400'}`;
const triggers = async (enabled) => {
  const response = await fetch(`${hub}/functions/${enabled ? 'enable' : 'disable'}BackgroundTriggers`, { method: 'PUT' });
  assert.equal(response.ok, true);
};
let app, db;

before(() => { app = initializeApp({ projectId }); db = getFirestore(app); });
after(async () => { await triggers(true).catch(() => {}); await deleteApp(app); });

test('phase 3 alert summaries are ordered, capped and carry counts only', () => {
  assert.deepEqual(phase3AlertSummaries({}), []);
  assert.deepEqual(phase3AlertSummaries({ ROLLOVER_FAILED: 1, STANDINGS_STALE: 30, REPORT_LEASE_EXPIRED: 0 }), [
    { code: 'STANDINGS_STALE', count: 25, truncated: true },
    { code: 'ROLLOVER_FAILED', count: 1, truncated: false },
  ]);
});

test('scheduled phase 3 monitor is read-only, honors enablement and reports only stuck or failed tenant work', async () => {
  const orgId = 'p314-monitor-org';
  const now = Date.now();
  const old = Timestamp.fromMillis(now - PHASE3_STUCK_AFTER_MS - 60_000);
  const fresh = Timestamp.fromMillis(now - 60_000);
  const docs = {
    [`organizations/${orgId}/competitions/stale`]: { schemaVersion: 2, orgId, standingsPendingSince: old, name: 'private competition' },
    [`organizations/${orgId}/competitions/fresh`]: { schemaVersion: 2, orgId, standingsPendingSince: fresh },
    [`organizations/${orgId}/competitions/stale/generations/abandoned`]: { state: 'building', startedAt: old },
    [`organizations/${orgId}/reportRuns/queued`]: { state: 'queued', queuedAt: old, filters: { teamId: 'private-team' } },
    [`organizations/${orgId}/reportRuns/lease`]: { state: 'building', queuedAt: old, leaseExpiresAt: old },
    [`organizations/${orgId}/reportRuns/live`]: { state: 'building', queuedAt: fresh, leaseExpiresAt: fresh },
    // Queued long ago but failed recently: counted by failure time.
    [`organizations/${orgId}/reportRuns/failed`]: { state: 'failed', queuedAt: Timestamp.fromMillis(now - 3 * 86_400_000), finishedAt: fresh, failure: { message: 'private failure' } },
    [`organizations/${orgId}/reportRuns/old-failure`]: { state: 'failed', queuedAt: fresh, finishedAt: Timestamp.fromMillis(now - 2 * 86_400_000) },
    [`organizations/${orgId}/rolloverJobs/queued`]: { state: 'queued', queuedAt: old, actorUid: 'private-user' },
    [`organizations/${orgId}/rolloverJobs/lease`]: { state: 'running', queuedAt: old, leaseExpiresAt: old },
    [`organizations/${orgId}/rolloverJobs/failed`]: { state: 'failed', queuedAt: Timestamp.fromMillis(now - 3 * 86_400_000), failedAt: fresh },
    [`organizations/${orgId}/rolloverJobs/old-failure`]: { state: 'failed', queuedAt: fresh, failedAt: Timestamp.fromMillis(now - 2 * 86_400_000) },
    // Outside the tenant tree: never counted.
    'reportRuns/stray': { state: 'queued', queuedAt: old },
  };
  const baseline = Object.fromEntries((await collectPhase3Alerts(now)).map((alert) => [alert.code, alert.count]));
  const logs = [];
  const originalWrite = logger.write;
  await triggers(false);
  try {
    await Promise.all(Object.entries(docs).map(([path, data]) => db.doc(path).set(data)));
    logger.write = (entry) => { if (entry.message === 'Phase 3 pilot alert.') logs.push(entry); };
    await db.doc('platformConfig/phase3Monitoring').set({ enabled: false });
    await monitorPhase3Pilot.run({});
    assert.deepEqual(logs, []);
    await db.doc('platformConfig/phase3Monitoring').set({ enabled: true });
    await monitorPhase3Pilot.run({});
    // The probe never writes: every seeded document is unchanged.
    for (const [path, data] of Object.entries(docs)) assert.deepEqual((await db.doc(path).get()).data(), data, path);
  } finally {
    logger.write = originalWrite;
    await Promise.all([...Object.keys(docs).map((path) => db.doc(path).delete()), db.doc('platformConfig/phase3Monitoring').delete()]);
    await triggers(true);
  }
  const codes = ['STANDINGS_STALE', 'STANDINGS_BUILD_ABANDONED', 'REPORT_QUEUED_STUCK', 'REPORT_LEASE_EXPIRED', 'REPORT_FAILED',
    'ROLLOVER_QUEUED_STUCK', 'ROLLOVER_LEASE_EXPIRED', 'ROLLOVER_FAILED'];
  assert.deepEqual(logs.map((entry) => entry.code), codes);
  // Other suites may leave work in the shared emulator, so each count is measured against the pre-seed baseline.
  for (const entry of logs) {
    assert.equal(entry.severity, 'ERROR');
    assert.equal(entry.count, Math.min(25, (baseline[entry.code] ?? 0) + 1), entry.code);
    assert.deepEqual(Object.keys(entry).sort(), ['code', 'count', 'message', 'severity', 'truncated']);
  }
  assert.equal(JSON.stringify(logs).includes('private'), false);
  assert.equal(JSON.stringify(logs).includes(orgId), false);
});
