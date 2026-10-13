import { spawnSync } from 'node:child_process';
// Do not inherit project aliases, ADC, or production credential overrides.
const env = { ...process.env };
for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CONFIG', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'FIREBASE_TOKEN', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST']) delete env[key];
const result = spawnSync('node_modules/.bin/firebase', [
  'emulators:exec', '--config', 'firebase.emulators.json', '--project', 'demo-team-hangout',
  '--only', 'auth,firestore,functions,storage', 'node --import tsx --test --test-concurrency=1 tests/backend/*.test.mjs',
], { stdio: 'inherit', env: { ...env, BACKEND_EMULATOR_TESTS: '1' } });
process.exit(result.status ?? 1);
