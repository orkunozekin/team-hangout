import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("rehearsal runner refuses relative evidence paths before starting Firebase", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/rehearsal/run.mjs", "relative.json"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /absolute evidence/);
});

test("scenario entry refuses real project, remote services, missing opt-in and credential overrides before writes", () => {
  const output = join(tmpdir(), `forbidden-rehearsal-${process.pid}.json`);
  const baseline = {
    ...process.env,
    PHASE1_REHEARSAL: "1",
    PHASE1_EVIDENCE: output,
    GCLOUD_PROJECT: "demo-team-hangout",
    FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
    FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    FIREBASE_STORAGE_EMULATOR_HOST: "127.0.0.1:9199",
  };
  delete baseline.GOOGLE_APPLICATION_CREDENTIALS;
  for (const override of [
    { GCLOUD_PROJECT: "real-project" },
    { FIRESTORE_EMULATOR_HOST: "remote.example.test:8080" },
    { FIREBASE_AUTH_EMULATOR_HOST: "remote.example.test:9099" },
    { FIREBASE_STORAGE_EMULATOR_HOST: "remote.example.test:9199" },
    { PHASE1_REHEARSAL: "" },
    { GOOGLE_APPLICATION_CREDENTIALS: "/tmp/forbidden-credentials.json" },
  ]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/rehearsal/scenarios.mjs"],
      { env: { ...baseline, ...override }, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Requires explicit isolated loopback demo emulators without credentials/,
    );
    assert.equal(existsSync(output), false);
  }
});

test(
  "synthetic setup failure preserves a readable private report",
  { skip: process.env.BACKEND_EMULATOR_TESTS !== "1" },
  async () => {
    const { requireEmulators } = await import("./fixtures.mjs");
    const { readFileSync, rmSync, statSync } = await import("node:fs");
    const { randomUUID } = await import("node:crypto");
    requireEmulators();
    const output = join(tmpdir(), `setup-failure-${randomUUID()}.json`);
    try {
      const result = spawnSync(
        process.execPath,
        ["scripts/rehearsal/scenarios.mjs"],
        {
          env: {
            ...process.env,
            PHASE1_REHEARSAL: "1",
            PHASE1_EVIDENCE: output,
            PHASE1_SCENARIOS: "operations",
            PHASE1_REHEARSAL_FAULT: "setup",
          },
          encoding: "utf8",
        },
      );
      assert.notEqual(result.status, 0);
      const report = JSON.parse(readFileSync(output, "utf8"));
      assert.equal(report.passed, false);
      assert.equal(report.failure.message, "SYNTHETIC_SETUP_FAILURE");
      assert.deepEqual(report.scenarios, {});
      assert.equal(statSync(output).mode & 0o777, 0o600);
    } finally {
      rmSync(output, { force: true });
    }
  },
);
