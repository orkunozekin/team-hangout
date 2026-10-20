import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const CI_GENERAL_MODE = '--ci-general';
export const CI_SCHEDULE_PUBLICATION_MODE = '--ci-schedule-publication';
export const OPERATIONS_MODE = '--operations';
export const SCHEDULE_PUBLICATION_SUITE = 'tests/backend/schedule-publication.test.mjs';

export const OPERATIONS_SUITES = [
  'tests/backend/contracts.test.mjs',
  'tests/backend/operation-helpers.test.mjs',
  'tests/backend/operational-events.test.mjs',
  'tests/backend/availability.test.mjs',
  'tests/backend/rsvp-reminder-plan.test.mjs',
  'tests/backend/rsvp-reminders.test.mjs',
  'tests/backend/attendance.test.mjs',
  'tests/backend/check-in.test.mjs',
  'tests/backend/facilities.test.mjs',
  'tests/backend/closures.test.mjs',
  'tests/backend/recurrence-pure.test.mjs',
  'tests/backend/recurrence.test.mjs',
  'tests/backend/schedule-drafts.test.mjs',
  SCHEDULE_PUBLICATION_SUITE,
  'tests/backend/organizations.test.mjs',
  'tests/backend/commands.test.mjs',
  'tests/backend/deletion.test.mjs',
  'tests/backend/functions.test.mjs',
];

export function parseBackendTestMode(args) {
  if (args.length > 1) throw new Error('Unknown backend test mode.');
  const mode = args[0];
  if (![undefined, OPERATIONS_MODE, CI_GENERAL_MODE, CI_SCHEDULE_PUBLICATION_MODE].includes(mode)) {
    throw new Error('Unknown backend test mode.');
  }
  return mode;
}

export function discoverBackendSuites(root = process.cwd()) {
  const directory = join(root, 'tests', 'backend');
  const suites = readdirSync(directory)
    .filter((file) => file.endsWith('.test.mjs'))
    .map((file) => `tests/backend/${file}`)
    .sort();
  if (suites.length === 0) throw new Error('No backend test suites discovered.');
  return suites;
}

export function partitionCiSuites(discoveredSuites) {
  const suites = [...discoveredSuites].sort();
  if (new Set(suites).size !== suites.length) throw new Error('Duplicate backend test suite discovered.');
  if (!suites.includes(SCHEDULE_PUBLICATION_SUITE)) {
    throw new Error('Schedule publication backend suite was not discovered.');
  }

  const publication = [SCHEDULE_PUBLICATION_SUITE];
  const general = suites.filter((suite) => suite !== SCHEDULE_PUBLICATION_SUITE);
  if (general.length === 0) throw new Error('General backend CI shard is empty.');
  const covered = [...general, ...publication].sort();
  if (general.includes(SCHEDULE_PUBLICATION_SUITE) || covered.length !== suites.length) {
    throw new Error('Backend CI shard partition is incomplete.');
  }
  for (let index = 0; index < suites.length; index += 1) {
    if (covered[index] !== suites[index]) throw new Error('Backend CI shard partition is incomplete.');
  }
  return { general, publication };
}

export function suitesForMode(mode, discoveredSuites = []) {
  if (mode === undefined) return ['tests/backend/*.test.mjs'];
  if (mode === OPERATIONS_MODE) return OPERATIONS_SUITES;
  const { general, publication } = partitionCiSuites(discoveredSuites);
  if (mode === CI_GENERAL_MODE) return general;
  if (mode === CI_SCHEDULE_PUBLICATION_MODE) return publication;
  throw new Error('Unknown backend test mode.');
}
