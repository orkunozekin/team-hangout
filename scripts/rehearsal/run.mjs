import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
const output = process.argv[2];
if (!output || !isAbsolute(output) || !output.endsWith(".json"))
  throw new Error(
    "Provide an absolute evidence .json path outside source control.",
  );
const scope = process.argv[3] || "all";
if (!["all", "scale", "operations"].includes(scope))
  throw new Error("Scenario scope must be all, scale or operations.");
const env = { ...process.env };
for (const key of [
  "GOOGLE_APPLICATION_CREDENTIALS",
  "FIREBASE_CONFIG",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT",
  "FIREBASE_TOKEN",
  "FIRESTORE_EMULATOR_HOST",
  "FIREBASE_AUTH_EMULATOR_HOST",
  "FIREBASE_STORAGE_EMULATOR_HOST",
])
  delete env[key];
// No Functions emulator: invoke real handlers/workers locally, with deliberate bounded service resumes.
const result = spawnSync(
  "node_modules/.bin/firebase",
  [
    "emulators:exec",
    "--config",
    "firebase.emulators.json",
    "--project",
    "demo-team-hangout",
    "--only",
    "auth,firestore,storage",
    "node scripts/rehearsal/scenarios.mjs",
  ],
  {
    stdio: "inherit",
    env: {
      ...env,
      PHASE1_REHEARSAL: "1",
      PHASE1_SCENARIOS: scope,
      PHASE1_EVIDENCE: output,
    },
  },
);
process.exit(result.status ?? 1);
