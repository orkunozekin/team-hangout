import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CI_GENERAL_MODE,
  CI_SCHEDULE_PUBLICATION_MODE,
  OPERATIONS_MODE,
  SCHEDULE_PUBLICATION_SUITE,
  discoverBackendSuites,
  parseBackendTestMode,
  partitionCiSuites,
  suitesForMode,
} from '../../scripts/backend-test-suites.mjs';

test('backend mode parsing preserves default and operations modes and rejects unknown input', () => {
  assert.equal(parseBackendTestMode([]), undefined);
  assert.equal(parseBackendTestMode([OPERATIONS_MODE]), OPERATIONS_MODE);
  assert.equal(parseBackendTestMode([CI_GENERAL_MODE]), CI_GENERAL_MODE);
  assert.equal(parseBackendTestMode([CI_SCHEDULE_PUBLICATION_MODE]), CI_SCHEDULE_PUBLICATION_MODE);
  assert.throws(() => parseBackendTestMode(['--unknown']), /Unknown backend test mode/);
  assert.throws(() => parseBackendTestMode([CI_GENERAL_MODE, CI_SCHEDULE_PUBLICATION_MODE]), /Unknown backend test mode/);
});

test('CI shards are deterministic, disjoint and cover every discovered backend suite', () => {
  const discovered = discoverBackendSuites();
  const { general, publication } = partitionCiSuites([...discovered].reverse());

  assert.deepEqual(publication, [SCHEDULE_PUBLICATION_SUITE]);
  assert.deepEqual(general, [...general].sort());
  assert.equal(general.includes(SCHEDULE_PUBLICATION_SUITE), false);
  assert.deepEqual([...general, ...publication].sort(), discovered);
  assert.deepEqual(suitesForMode(CI_GENERAL_MODE, discovered), general);
  assert.deepEqual(suitesForMode(CI_SCHEDULE_PUBLICATION_MODE, discovered), publication);
  assert.deepEqual(suitesForMode(undefined), ['tests/backend/*.test.mjs']);
  assert.equal(suitesForMode(OPERATIONS_MODE).includes(SCHEDULE_PUBLICATION_SUITE), true);
  assert.throws(() => suitesForMode('--unknown', discovered), /Unknown backend test mode/);
});

test('CI partition fails closed when discovery is missing or ambiguous', () => {
  assert.throws(() => partitionCiSuites(['tests/backend/functions.test.mjs']), /was not discovered/);
  assert.throws(() => partitionCiSuites([SCHEDULE_PUBLICATION_SUITE]), /General backend CI shard is empty/);
  assert.throws(
    () => partitionCiSuites([SCHEDULE_PUBLICATION_SUITE, SCHEDULE_PUBLICATION_SUITE]),
    /Duplicate backend test suite/,
  );
});
