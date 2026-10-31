// Reviewed live entry point for the legacy -> organization migration.
// The demo-only scripts/migrations/legacy.mjs stays unchanged; this file reuses the same
// plan/apply core with an exact project allowlist and explicit approval flags.
//
//   dry-run   : read-only inventory (Firestore read-only transaction) -> private plan file + checksum
//   apply     : requires --checksum of the saved plan, --confirm-project <same id>, --writers-stopped
//   reconcile : read-only access reconciliation of an applied plan
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const MAX_PLAN_AGE_HOURS = 24;
const fail = (message, code = 64) => { console.error(`legacy-live: ${message}`); process.exit(code); };

const { values } = (() => {
  try {
    return parseArgs({ strict: true, options: {
      project: { type: 'string' }, 'dry-run': { type: 'boolean' }, apply: { type: 'boolean' }, reconcile: { type: 'boolean' },
      manifest: { type: 'string' }, out: { type: 'string' }, plan: { type: 'string' }, checksum: { type: 'string' },
      'confirm-project': { type: 'string' }, 'writers-stopped': { type: 'boolean' }, 'max-operations': { type: 'string' },
      database: { type: 'string' },
    } });
  } catch (error) { fail(error.message); }
})();

const require = createRequire(new URL('../../functions/package.json', import.meta.url));
const legacy = require('./lib/migrations/legacy.js');
const { ALLOWED_PROJECTS, EMULATOR_PROJECT } = legacy;

// Every guard below runs before any Firebase client exists.
const project = values.project;
if (!project) fail('--project is required.');
if (!ALLOWED_PROJECTS.includes(project)) fail(`Project ${project} is not allowlisted.`);
const modes = ['dry-run', 'apply', 'reconcile'].filter(mode => values[mode]);
if (modes.length !== 1) fail('Choose exactly one of --dry-run, --apply or --reconcile.');
const [mode] = modes;
if (mode === 'dry-run' && (!values.manifest || !values.out)) fail('--dry-run needs --manifest and --out.');
if (mode !== 'dry-run' && (!values.plan || !values.checksum)) fail(`--${mode} needs --plan and the approved --checksum.`);
if (mode !== 'dry-run' && !/^[0-9a-f]{64}$/.test(values.checksum)) fail('--checksum must be the 64-character plan SHA-256.');
if (mode === 'apply') {
  if (values['confirm-project'] !== project) fail('--apply needs --confirm-project equal to --project.');
  if (!values['writers-stopped']) fail('--apply needs --writers-stopped: stop all legacy writers and keep deny-first rules deployed first.');
}
const maxOperations = values['max-operations'] === undefined ? Infinity : Number(values['max-operations']);
if (!(maxOperations === Infinity || Number.isInteger(maxOperations) && maxOperations > 0)) fail('--max-operations must be a positive integer.');

if (values.database && project !== EMULATOR_PROJECT) fail('--database is only for isolated emulator rehearsals.');
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
if (project === EMULATOR_PROJECT) {
  if (emulatorHost !== '127.0.0.1:8080' || process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIREBASE_TOKEN) fail('The demo project runs only against the loopback Firestore emulator without credentials.');
} else {
  if (emulatorHost || process.env.FIREBASE_AUTH_EMULATOR_HOST) fail('Unset emulator hosts before targeting a real project.');
  for (const key of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) if (process.env[key] && process.env[key] !== project) fail(`${key} does not match --project.`);
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (keyFile) {
    const credential = JSON.parse(await readFile(keyFile, 'utf8'));
    if (credential.project_id && credential.project_id !== project) fail('Credential project_id does not match --project.');
  }
}

let plan;
if (mode !== 'dry-run') {
  plan = legacy.decode(JSON.parse(await readFile(values.plan, 'utf8')));
  if (plan.project !== project) fail('Plan was generated for a different project.');
  if (legacy.checksum(plan) !== values.checksum) fail('Approved plan checksum mismatch.');
}
const manifest = mode === 'dry-run' ? JSON.parse(await readFile(values.manifest, 'utf8')) : null;

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const app = project === EMULATOR_PROJECT
  ? initializeApp({ projectId: project }, 'legacy-live')
  : initializeApp({ projectId: project, credential: applicationDefault() }, 'legacy-live');
if (app.options.projectId !== project) fail('Initialized project does not match --project.');
const db = values.database ? getFirestore(app, values.database) : getFirestore(app);

if (mode === 'dry-run') {
  const inventory = await legacy.collectInventory(db);
  const built = legacy.buildPlan(manifest, inventory);
  const generated = { ...built, project, report: { ...built.report, generatedAt: new Date().toISOString() } };
  await writeFile(values.out, JSON.stringify(legacy.encode(generated), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ checksum: legacy.checksum(generated), summary: legacy.summarize(generated) }, null, 2));
  if (built.report.issues.length || built.report.orphanPaths.length) process.exitCode = 2;
} else if (mode === 'apply') {
  // A fresh start needs a recent plan; resuming the same approved run is allowed later.
  const run = await db.doc(`legacyMigrationRuns/${plan.runId}`).get();
  const age = Date.now() - Date.parse(plan.report?.generatedAt ?? '');
  if (!(run.exists && run.data()?.checksum === values.checksum) && !(age >= 0 && age <= MAX_PLAN_AGE_HOURS * 3600000)) fail(`Plan is older than ${MAX_PLAN_AGE_HOURS}h or undated; run a fresh dry-run and re-approve.`);
  const result = await legacy.applyPlan(db, plan, values.checksum, maxOperations);
  const access = result.complete ? await legacy.reconcileAccess(db, plan) : null;
  console.log(JSON.stringify({ ...result, access: access && { ok: access.ok, members: access.members, coaches: access.coaches, players: access.players, mismatches: access.mismatches.length } }, null, 2));
  if (access && !access.ok) process.exitCode = 3;
} else {
  const access = await legacy.reconcileAccess(db, plan);
  console.log(JSON.stringify({ ok: access.ok, members: access.members, coaches: access.coaches, players: access.players, mismatches: access.mismatches }, null, 2));
  if (!access.ok) process.exitCode = 3;
}
