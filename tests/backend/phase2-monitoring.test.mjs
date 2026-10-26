import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { projectId, requireEmulators } from './fixtures.mjs';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const logger = require('firebase-functions/logger');
const { monitorPhase2Pilot, phase2AlertSummaries } = require('./lib/operations/monitoring.js');
requireEmulators();
let app, db;

before(() => { app = initializeApp({ projectId }); db = getFirestore(app); });
after(async () => { await deleteApp(app); });

test('phase 2 monitoring reports only actionable bounded summaries', () => {
  const alerts = phase2AlertSummaries({
    publicationAgesMs: [9 * 60_000, 10 * 60_000],
    deletionAgesMs: [11 * 60_000],
    scanFailureAgesMs: [1_000, 2_000, 3_000, 16 * 60_000],
    cleanupRetryCount: 1,
  });
  assert.deepEqual(alerts, [
    { code: 'PUBLICATION_STUCK', count: 1, truncated: false },
    { code: 'DELETION_STUCK', count: 1, truncated: false },
    { code: 'SCAN_FAILED_REPEATED', count: 3, truncated: false },
    { code: 'CLEANUP_RETRY_REQUIRED', count: 1, truncated: false },
  ]);
  assert.equal(JSON.stringify(alerts).includes('uid'), false);
  assert.equal(JSON.stringify(alerts).includes('file'), false);
});

test('phase 2 monitoring stays quiet below thresholds and bounds counts', () => {
  assert.deepEqual(phase2AlertSummaries({ publicationAgesMs: [599_999], deletionAgesMs: [], scanFailureAgesMs: [1, 2], cleanupRetryCount: 0 }), []);
  const alerts = phase2AlertSummaries({
    publicationAgesMs: Array(30).fill(600_000),
    deletionAgesMs: Array(30).fill(600_000),
    scanFailureAgesMs: Array(101).fill(1),
    cleanupRetryCount: 30,
  });
  assert.deepEqual(alerts.map(({ count, truncated }) => ({ count, truncated })), [
    { count: 25, truncated: true },
    { count: 25, truncated: true },
    { count: 100, truncated: true },
    { count: 25, truncated: true },
  ]);
});

test('scheduled phase 2 monitor honors enablement, queries all conditions, and emits redacted summaries', async () => {
  const orgId = 'phase2-monitoring-org';
  const old = Timestamp.fromMillis(Date.now() - 11 * 60_000);
  const recent = Timestamp.fromMillis(Date.now() - 60_000);
  const refs = [
    db.doc(`organizations/${orgId}/scheduleOperations/stuck`),
    db.doc(`organizations/${orgId}/attachments/scan-1`),
    db.doc(`organizations/${orgId}/attachments/scan-2`),
    db.doc(`organizations/${orgId}/attachments/scan-3`),
    db.doc('accountDeletionJobs/phase2-monitoring-delete'),
    db.doc('accountDeletionJobs/phase2-monitoring-cleanup'),
  ];
  await Promise.all([
    refs[0].set({ state: 'promoting', updatedAt: old, privateDetails: 'must not appear' }),
    ...refs.slice(1, 4).map(ref => ref.set({ state: 'rejected', rejectionCode: 'SCAN_FAILED', updatedAt: recent, fileName: 'private.pdf' })),
    refs[4].set({ status: 'pending', updatedAt: old, uid: 'private-user' }),
    refs[5].set({ status: 'complete', lastError: 'CLEANUP_RETRY_REQUIRED', updatedAt: recent, uid: 'private-user' }),
  ]);
  const logs = [];
  const originalError = logger.error;
  logger.error = (...args) => { if (args[0] === 'Phase 2 pilot alert.') logs.push(args[1]); };
  try {
    await db.doc('platformConfig/phase2Monitoring').set({ enabled: false, organizationIds: [orgId] });
    await monitorPhase2Pilot.run({});
    assert.deepEqual(logs, []);
    await db.doc('platformConfig/phase2Monitoring').set({ enabled: true, organizationIds: [orgId] });
    await monitorPhase2Pilot.run({});
  } finally {
    logger.error = originalError;
    await Promise.all([...refs.map(ref => ref.delete()), db.doc('platformConfig/phase2Monitoring').delete()]);
  }
  assert.deepEqual(logs.map(({ code, count, truncated, monitoredOrganizations }) => ({ code, count, truncated, monitoredOrganizations })), [
    { code: 'PUBLICATION_STUCK', count: 1, truncated: false, monitoredOrganizations: 1 },
    { code: 'DELETION_STUCK', count: 1, truncated: false, monitoredOrganizations: 1 },
    { code: 'SCAN_FAILED_REPEATED', count: 3, truncated: false, monitoredOrganizations: 1 },
    { code: 'CLEANUP_RETRY_REQUIRED', count: 1, truncated: false, monitoredOrganizations: 1 },
  ]);
  assert.equal(JSON.stringify(logs).includes('private'), false);
});
