import { spawnSync } from 'node:child_process';
const env = { ...process.env };
for (const key of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_CONFIG', 'GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT', 'FIREBASE_TOKEN', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) delete env[key];
const result = spawnSync('node_modules/.bin/firebase', [
  'emulators:exec', '--config', 'firebase.emulators.json', '--project', 'demo-team-hangout',
  '--only', 'auth,firestore,functions', 'yarn --cwd admin test',
], { stdio: 'inherit', env: { ...env, ADMIN_EMULATOR_TESTS: '1' } });
process.exit(result.status ?? 1);
