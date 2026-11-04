import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const safeEnv = () => {
  const env = {
    ...process.env,
    GCLOUD_PROJECT: "demo-team-hangout",
    FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
    FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    FUNCTIONS_EMULATOR_HOST: "127.0.0.1:5001",
  };
  for (const key of [
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GCP_PROJECT",
    "FIREBASE_CONFIG",
  ])
    delete env[key];
  return env;
};

test("Phase 3 demo seed refuses real projects, remote hosts and credential overrides before loading Firebase", () => {
  for (const override of [
    { GCLOUD_PROJECT: "team-hangout" },
    { GCLOUD_PROJECT: undefined },
    { GOOGLE_CLOUD_PROJECT: "team-hangout" },
    { FIREBASE_CONFIG: JSON.stringify({ projectId: "team-hangout" }) },
    { GOOGLE_APPLICATION_CREDENTIALS: "/tmp/service-account.json" },
    { FIRESTORE_EMULATOR_HOST: "firestore.googleapis.com:443" },
    { FIREBASE_AUTH_EMULATOR_HOST: undefined },
    { FUNCTIONS_EMULATOR_HOST: "10.0.0.5:5001" },
  ]) {
    const env = { ...safeEnv(), ...override };
    for (const [key, value] of Object.entries(override))
      if (value === undefined) delete env[key];
    const result = spawnSync(
      process.execPath,
      ["scripts/seed-phase3-demo.mjs"],
      { encoding: "utf8", env, timeout: 15_000 },
    );
    assert.notEqual(result.status, 0, JSON.stringify(override));
    assert.match(
      result.stderr,
      /Synthetic Phase 3 seed (requires demo-team-hangout|refuses)/,
      JSON.stringify(override),
    );
  }
});
