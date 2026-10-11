// Deliberately emulator-only. Production/staging execution requires a separately reviewed release.
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { buildPlan, applyPlan, checksum, encode, decode } = require('./lib/migrations/legacy.js');
const [mode, input, outputOrChecksum] = process.argv.slice(2);
if (!['dry-run', 'apply'].includes(mode) || !input || !outputOrChecksum) throw new Error('Usage: node scripts/migrations/legacy.mjs dry-run manifest.json plan.json | apply plan.json APPROVED_CHECKSUM');
if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8080' || process.env.GCLOUD_PROJECT !== 'demo-team-hangout'
  || process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_CONFIG || process.env.FIREBASE_TOKEN) throw new Error('Requires isolated demo project, loopback Firestore emulator, and no credential overrides.');
initializeApp({ projectId: 'demo-team-hangout' });
const db = getFirestore();
const data = decode(JSON.parse(await readFile(input, 'utf8')));
if (mode === 'dry-run') {
  const inventory = {};
  for (const kind of ['teams', 'teamMembers', 'events', 'inviteCodes', 'users', 'organizations']) {
    for (const doc of (await db.collection(kind).get()).docs) {
      inventory[doc.ref.path] = doc.data();
      if (kind === 'organizations') {
        for (const child of ['programs', 'seasons', 'divisions', 'participants']) {
          for (const row of (await doc.ref.collection(child).get()).docs) inventory[row.ref.path] = row.data();
        }
      }
      if (kind === 'teams') for (const row of (await doc.ref.collection('roster').get()).docs) inventory[row.ref.path] = row.data();
    }
  }
  const plan = buildPlan(data, inventory);
  await writeFile(outputOrChecksum, JSON.stringify(encode(plan), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ checksum: checksum(plan), report: plan.report }, null, 2));
  if (plan.report.issues.length || plan.report.orphanPaths.length) process.exitCode = 2;
} else {
  console.log(JSON.stringify(await applyPlan(db, data, outputOrChecksum)));
}
