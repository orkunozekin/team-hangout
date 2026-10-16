import { spawnSync } from 'node:child_process';
// Do not inherit project aliases, ADC, or production credential overrides.
const mode = process.argv[2];
if (mode !== undefined && mode !== '--operations') throw new Error('Unknown backend test mode.');
// This focused gate always retains account deletion coverage. Full CI still runs every suite.
const suites = mode === '--operations'
  ? 'tests/backend/contracts.test.mjs tests/backend/operation-helpers.test.mjs tests/backend/operational-events.test.mjs tests/backend/facilities.test.mjs tests/backend/recurrence-pure.test.mjs tests/backend/recurrence.test.mjs tests/backend/schedule-drafts.test.mjs tests/backend/organizations.test.mjs tests/backend/commands.test.mjs tests/backend/deletion.test.mjs tests/backend/functions.test.mjs'
  : 'tests/backend/*.test.mjs';
const env = { ...process.env };
for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CONFIG', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'FIREBASE_TOKEN', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST']) delete env[key];
const result = spawnSync('node_modules/.bin/firebase', [
  'emulators:exec', '--config', 'firebase.emulators.json', '--project', 'demo-team-hangout',
  '--only', 'auth,firestore,functions,storage', `node --import tsx --test --test-concurrency=1 ${suites}`,
], { stdio: 'inherit', env: { ...env, BACKEND_EMULATOR_TESTS: '1' } });
process.exit(result.status ?? 1);
