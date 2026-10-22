import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { phase2AlertSummaries } = require('./lib/operations/monitoring.js');

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
