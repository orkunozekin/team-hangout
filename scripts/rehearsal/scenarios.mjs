import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { writeFileSync, openSync, closeSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { cpus, totalmem, platform, release, arch } from "node:os";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
if (
  process.env.PHASE1_REHEARSAL !== "1" ||
  process.env.GCLOUD_PROJECT !== "demo-team-hangout" ||
  process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8080" ||
  process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9099" ||
  process.env.FIREBASE_STORAGE_EMULATOR_HOST !== "127.0.0.1:9199" ||
  process.env.GOOGLE_APPLICATION_CREDENTIALS
)
  throw new Error(
    "Requires explicit isolated loopback demo emulators without credentials.",
  );
if (
  !process.env.PHASE1_EVIDENCE ||
  !isAbsolute(process.env.PHASE1_EVIDENCE) ||
  !process.env.PHASE1_EVIDENCE.endsWith(".json")
)
  throw new Error("Requires absolute evidence .json path.");
const output = openSync(process.env.PHASE1_EVIDENCE, "wx", 0o600);
process.env.FUNCTIONS_EMULATOR = "true"; // Enables demo mailbox/config only; no deployed Functions or provider.
const require = createRequire(
  new URL("../../functions/package.json", import.meta.url),
);
const handlers = require("./lib/index.js");
const express = require("express");
const web = express();
web.get("/feed", handlers.calendarFeed);
const server = createServer(web);
server.listen(0, "127.0.0.1");
await once(server, "listening");
const feedOrigin = `http://127.0.0.1:${server.address().port}`;
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { deleteApp, getApp } = require("firebase-admin/app");
const {
  buildPlan,
  applyPlan,
  checksum,
} = require("./lib/migrations/legacy.js");
const { runRosterImport } = require("./lib/imports/roster.js");
const { processOutbox } = require("./lib/email/worker.js");
const { beginDeletion, resumeDeletion } = require("./lib/accounts/deletion.js");
const db = getFirestore();
const scope = process.env.PHASE1_SCENARIOS || "all";
if (!["all", "scale", "operations"].includes(scope))
  throw new Error("Invalid rehearsal scope.");
let sequence = 0,
  meter = null;
const transact = db.runTransaction.bind(db);
// Count snapshots requested by production handler transactions, including retries/empty queries.
// This is SDK read work, not a claim about billed production reads or index entries.
db.runTransaction = (action, options) =>
  transact(
    (tx) =>
      action(
        new Proxy(tx, {
          get(target, name) {
            if (name === "get" || name === "getAll")
              return async (...args) => {
                const result = await target[name](...args);
                if (meter) {
                  meter.requests++;
                  meter.documents += Array.isArray(result)
                    ? result.length
                    : "docs" in result
                      ? result.size
                      : 1;
                  if ("docs" in result && result.empty) meter.emptyQueries++;
                }
                return result;
              };
            const value = target[name];
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      ),
    options,
  );
const call = (name, uid, data) =>
  handlers[name].run({
    data,
    auth: {
      uid,
      token: {
        email: `${uid}@example.test`,
        email_verified: true,
        auth_time: Math.floor(Date.now() / 1000),
      },
    },
  });
const request = (data) => ({ ...data, requestId: `rehearsal-${++sequence}` });
const results = {
  environment: {
    kind: "local-emulator",
    scope,
    scriptSha256: createHash("sha256")
      .update(readFileSync(new URL(import.meta.url)))
      .digest("hex"),
    project: "demo-team-hangout",
    region: "none, loopback; handler default us-central1 unmeasured",
    node: process.version,
    os: `${platform()} ${release()} ${arch()}`,
    cpu: cpus()[0]?.model,
    cores: cpus().length,
    memoryGiB: totalmem() / 2 ** 30,
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    dirty: !!execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    }).trim(),
    recordedAt: new Date().toISOString(),
    invocation:
      "real callable .run and service workers in one local Node process; excludes HTTP/auth/network/cold start and scheduled wait",
    readMetric:
      "transaction snapshot requests; includes retries, missing documents and repeated reads; excludes index-entry/billing accounting, setup/poll reconciliation reads and worker reads outside transactions",
  },
  gates: { staging: "not run", ownerAcceptance: "pending", pilotReady: false },
  scenarios: {},
};
async function measured(name, action) {
  meter = { requests: 0, documents: 0, emptyQueries: 0 };
  const start = performance.now();
  try {
    const value = await action();
    results.scenarios[name] = {
      ms: performance.now() - start,
      transactionReads: { ...meter },
      ...value,
    };
    return value;
  } finally {
    meter = null;
  }
}
const owner = "rehearsal-owner",
  parent = "rehearsal-parent",
  other = "rehearsal-other";
const meta = {
  schemaVersion: 2,
  status: "active",
  revision: 1,
  createdBy: owner,
  updatedBy: owner,
  createdAt: Timestamp.now(),
  updatedAt: Timestamp.now(),
};
async function seed(rows) {
  for (let start = 0; start < rows.length; start += 400) {
    const batch = db.batch();
    for (const [path, data] of rows.slice(start, start + 400))
      batch.set(db.doc(path), data);
    await batch.commit();
  }
}
const orgs = ["rehearsal-a", "rehearsal-b"];
const teams = Array.from(
  { length: 20 },
  (_, i) => `rehearsal-team-${String(i).padStart(2, "0")}`,
);
const from = new Date();
from.setUTCHours(0, 0, 0, 0);
const window = {
  from: from.toISOString(),
  to: new Date(+from + 93 * 86400000).toISOString(),
  pageSize: 20,
};
const rows = [];
for (const uid of [owner, parent, other]) {
  await getAuth().createUser({
    uid,
    email: `${uid}@example.test`,
    emailVerified: true,
  });
  rows.push([`users/${uid}`, { uid, appRole: "user" }]);
}
for (const orgId of orgs) {
  const base = { ...meta, orgId };
  rows.push(
    [
      `organizations/${orgId}`,
      {
        ...base,
        name: orgId,
        features: {
          organizationV2: true,
          households: true,
          imports: true,
          adminWorkspace: true,
          calendarSubscriptions: true,
          essentialEmail: true,
        },
      },
    ],
    [
      `organizations/${orgId}/members/${owner}`,
      { ...base, roles: ["orgAdmin"], programIds: [] },
    ],
    [`organizations/${orgId}/programs/soccer`, { ...base, name: "Soccer" }],
    [
      `organizations/${orgId}/seasons/fall`,
      {
        ...base,
        programId: "soccer",
        name: "Fall",
        startsOn: "2026-01-01",
        endsOn: "2028-12-31",
      },
    ],
    [
      `organizations/${orgId}/divisions/u12`,
      { ...base, programId: "soccer", seasonId: "fall" },
    ],
  );
  for (const participantId of ["jamie", "casey"]) {
    rows.push([
      `organizations/${orgId}/participants/${participantId}`,
      {
        ...base,
        displayName:
          participantId === "jamie" ? "Jamie Example" : "Casey Example",
        kind: "youth",
        linkedUserId: null,
      },
    ]);
    for (const uid of [parent, other])
      rows.push([
        `organizations/${orgId}/participants/${participantId}/guardians/${uid}`,
        {
          ...base,
          userId: uid,
          participantId,
          permissions: { viewSchedule: true, viewProfile: true },
        },
      ]);
  }
}
for (const [i, teamId] of teams.entries()) {
  const orgId = orgs[i < 10 ? 0 : 1],
    base = {
      ...meta,
      orgId,
      programId: "soccer",
      seasonId: "fall",
      divisionId: "u12",
    };
  rows.push([
    `teams/${teamId}`,
    { ...base, name: `Synthetic team ${i + 1}`, externalId: `T${i}` },
  ]);
  for (const participantId of ["jamie", "casey"])
    rows.push([
      `teams/${teamId}/roster/${participantId}`,
      { ...meta, orgId, participantId },
    ]);
  for (let day = 0; day < 93; day++) {
    const startsAt = Timestamp.fromMillis(
      +from + day * 86400000 + 18 * 3600000,
    );
    rows.push([
      `events/${teamId}-${String(day).padStart(3, "0")}`,
      {
        ...base,
        title: "Synthetic practice",
        type: "practice",
        teamId,
        teamIds: [teamId],
        startsAt,
        endsAt: Timestamp.fromMillis(startsAt.toMillis() + 3600000),
        timeZone: "America/Chicago",
        status: "scheduled",
        publicationState: "published",
        publicationOperationId: null,
        deletedAt: null,
        location: { name: "Example field" },
      },
    ]);
  }
}
await seed(rows);
try {
  if (scope !== "operations")
    await measured("agenda", async () => {
      const samples = [];
      for (let i = 0; i < 21; i++) {
        const start = performance.now(),
          page = await call("listHouseholdAgenda", parent, window);
        assert.equal(page.teams.length, 20);
        assert.equal(page.items.length, 20);
        assert.equal(new Set(page.items.map((x) => x.id)).size, 20);
        assert.equal(page.items[0].participants.length, 2);
        samples.push(performance.now() - start);
      }
      const warm = samples.slice(1).sort((a, b) => a - b),
        p95 = warm[Math.ceil(warm.length * 0.95) - 1];
      return {
        teamCount: 20,
        eventCount: 1860,
        days: 93,
        pageSize: 20,
        sampleCount: 20,
        firstCallMs: samples[0],
        warmSamplesMs: samples.slice(1),
        p95Ms: p95,
        localTargetPass: p95 < 2000,
      };
    });
  for (const kind of scope === "operations" ? [] : ["roster", "schedule"])
    await measured(`${kind}5000`, async () => {
      const headers =
        kind === "roster"
          ? "externalId,participantName,kind,teamExternalId,guardianEmail1,guardianEmail2"
          : "externalId,teamExternalId,eventType,title,localDate,localStartTime,localEndTime,timeZone,locationName,address,notes";
      const lines = Array.from({ length: 5000 }, (_, i) =>
        kind === "roster"
          ? `person-${i},Synthetic participant ${i},youth,T${i % 10},,`
          : `schedule-${i},T${i % 10},practice,Synthetic imported practice,2027-01-${String(1 + (Math.floor(i / 240) % 28)).padStart(2, "0")},${String(Math.floor(i / 10) % 24).padStart(2, "0")}:00,${String(Math.floor(i / 10) % 24).padStart(2, "0")}:30,America/Chicago,Example field,,`,
      );
      const input = request({
        orgId: orgs[0],
        programId: "soccer",
        seasonId: "fall",
        templateVersion: 1,
        csvBase64: Buffer.from(`${headers}\n${lines.join("\n")}`).toString(
          "base64",
        ),
        mapping: Object.fromEntries(headers.split(",").map((k) => [k, k])),
      });
      const started = performance.now(),
        uploaded = await call(
          kind === "roster" ? "uploadRosterImport" : "uploadScheduleImport",
          owner,
          input,
        ),
        jobId = uploaded.job.id;
      const drive = async (desired) => {
        for (let page = 0; page < 250; page++) {
          await runRosterImport(jobId, 25);
          const job = (await db.doc(`importJobs/${jobId}`).get()).data();
          if (job.status === desired) return job;
          assert.ok(
            ["previewing", "committing"].includes(job.status),
            `Unexpected ${kind} status ${job.status}: ${job.error}`,
          );
        }
        throw new Error("Bounded worker budget exhausted");
      };
      const preview = await drive("preview"),
        previewMs = performance.now() - started;
      assert.equal(preview.count, 5000);
      assert.equal(preview.unresolved, 0);
      assert.equal((await db.collection("emailOutbox").get()).size, 0);
      const confirm = request({
        orgId: orgs[0],
        jobId,
        previewRevision: preview.previewRevision,
        planRevision: preview.planRevision,
        confirmed: true,
      });
      const committing = performance.now();
      await call(
        kind === "roster" ? "commitRosterImport" : "commitScheduleImport",
        owner,
        confirm,
      );
      const done = await drive("complete"),
        commitMs = performance.now() - committing;
      assert.equal(done.created, 5000);
      assert.equal(done.checkpoint, 5000);
      await call(
        kind === "roster" ? "commitRosterImport" : "commitScheduleImport",
        owner,
        confirm,
      );
      assert.equal((await db.collection("emailOutbox").get()).size, 0);
      if (kind === "schedule") {
        const imported = await db
          .collection("events")
          .where("publicationState", "==", "staged")
          .get();
        assert.equal(imported.size, 5000);
      }
      console.log(
        `${kind}: preview ${Math.round(previewMs)}ms, commit ${Math.round(commitMs)}ms`,
      );
      return {
        count: 5000,
        workerBudget: 25,
        previewMs,
        commitMs,
        totalMs: previewMs + commitMs,
        rowsPerSecond: 5000 / (commitMs / 1000),
        localTargetPass: previewMs + commitMs < 600000,
        replay: "confirmed, no new outbox",
      };
    });
  if (scope !== "scale")
    await measured("migration", async () => {
      const inventory = {};
      const orgId = "rehearsal-migration";
      for (const [suffix, value] of [
        ["", { ...meta, features: { organizationV2: true } }],
        ["/programs/soccer", { ...meta, orgId }],
        ["/seasons/fall", { ...meta, orgId, programId: "soccer" }],
        [
          "/divisions/u12",
          { ...meta, orgId, programId: "soccer", seasonId: "fall" },
        ],
      ])
        inventory[`organizations/${orgId}${suffix}`] = value;
      inventory["users/migration-player"] = { displayName: "Synthetic player" };
      inventory["users/migration-coach"] = { displayName: "Synthetic coach" };
      for (const teamId of ["migration-mapped", "migration-unmapped"]) {
        inventory[`teams/${teamId}`] = {
          name: teamId,
          createdBy: "migration-coach",
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          inviteCode: teamId === "migration-mapped" ? "AAAAAAAA" : "BBBBBBBB",
        };
        inventory[
          `inviteCodes/${teamId === "migration-mapped" ? "AAAAAAAA" : "BBBBBBBB"}`
        ] = { teamId };
        inventory[`teamMembers/${teamId}_migration-player`] = {
          teamId,
          userId: "migration-player",
          role: "player",
          joinedAt: Timestamp.now(),
        };
        inventory[`events/${teamId}`] = {
          teamId,
          createdBy: "migration-coach",
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          title: "Synthetic legacy practice",
          type: "practice",
          date: Timestamp.fromDate(new Date("2026-10-13T00:00:00Z")),
          time: "18:30",
          deletedAt: null,
        };
      }
      await seed(Object.entries(inventory));
      const manifest = {
        version: 1,
        noEmail: true,
        confirmedAt: "2026-10-13T12:00:00.000Z",
        mappings: [
          {
            teamId: "migration-mapped",
            orgId,
            programId: "soccer",
            seasonId: "fall",
            divisionId: "u12",
            timeZone: "America/Chicago",
            confirmedBy: "synthetic-reviewer",
            defaultDurationMinutes: 60,
          },
        ],
      };
      const plan = buildPlan(manifest, inventory),
        digest = checksum(plan);
      assert.deepEqual(plan.report.issues, []);
      assert.deepEqual(plan.report.orphanPaths, []);
      assert.equal((await applyPlan(db, plan, digest, 3)).complete, false);
      const completed = await applyPlan(db, plan, digest);
      assert.equal(completed.complete, true);
      assert.deepEqual(await applyPlan(db, plan, digest), completed);
      for (const op of plan.operations)
        assert.equal(
          checksum((await db.doc(op.path).get()).data()),
          checksum(op.after),
        );
      assert.equal(
        checksum((await db.doc("teams/migration-unmapped").get()).data()),
        checksum(inventory["teams/migration-unmapped"]),
      );
      return {
        checksum: digest,
        operationCount: plan.operations.length,
        counts: plan.report.counts,
        resumed: true,
        replayPostimagesIdentical: true,
        unmappedPreserved: true,
        noEmail: true,
      };
    });
  if (scope !== "scale")
    await measured("revokeAndDeletion", async () => {
      const orgId = orgs[0],
        teamId = teams[0],
        eventId = `${teamId}-000`;
      const issued = await call(
        "createCalendarSubscription",
        parent,
        request({
          teamIds: [teamId],
          participantRefs: [
            { orgId, participantId: "jamie" },
            { orgId, participantId: "casey" },
          ],
          eventTypes: ["practice"],
          includeParticipantNames: false,
        }),
      );
      const feed = async () => {
        const response = await fetch(
          `${feedOrigin}/feed?token=${new URL(issued.url).searchParams.get("token")}`,
        );
        return { code: response.status, body: await response.text() };
      };
      assert.equal((await feed()).code, 200);
      await call(
        "revokeCalendarSubscription",
        parent,
        request({
          subscriptionId: issued.subscription.id,
          expectedRevision: issued.subscription.revision,
        }),
      );
      const revoked = await feed();
      assert.equal(revoked.code, 404);
      assert.ok(!revoked.body.includes("VEVENT"));
      const queue = async (key, uid) =>
        db
          .doc(`emailOutbox/${key}`)
          .set({
            kind: "publishedEvent",
            orgId,
            eventId,
            eventRevision: 1,
            recipientUid: uid,
            recipientEmail: `${uid}@example.test`,
            status: "queued",
            attemptCount: 0,
            nextAttemptAt: Timestamp.now(),
          });
      await queue("rehearsal-sent", other);
      assert.equal(await processOutbox("rehearsal-sent"), "sent");
      await queue("rehearsal-revoked", parent);
      for (const organization of orgs)
        for (const participantId of ["jamie", "casey"])
          await db
            .doc(
              `organizations/${organization}/participants/${participantId}/guardians/${parent}`,
            )
            .update({ status: "revoked" });
      assert.equal(
        (await call("listHouseholdAgenda", parent, window)).items.length,
        0,
      );
      assert.equal(await processOutbox("rehearsal-revoked"), "cancelled");
      assert.equal(
        (await db.doc("developmentMailbox/rehearsal-revoked").get()).exists,
        false,
      );
      await beginDeletion(parent);
      await assert.rejects(
        call("listHouseholdAgenda", parent, window),
        (e) => e.code === "permission-denied",
      );
      let state = await resumeDeletion(parent, 1);
      assert.equal(state.status, "pending");
      for (let i = 0; i < 10 && state.status !== "complete"; i++)
        state = await resumeDeletion(parent, 30);
      assert.equal(state.status, "complete");
      await assert.rejects(
        getAuth().getUser(parent),
        (e) => e.code === "auth/user-not-found",
      );
      assert.equal(
        (await call("listHouseholdAgenda", other, window)).teams.length,
        20,
      );
      assert.equal(
        (await db.doc(`organizations/${orgId}/participants/jamie`).get())
          .exists,
        true,
      );
      assert.equal((await db.doc(`events/${eventId}`).get()).exists, true);
      return {
        feed: "200 then 404 without event data",
        email:
          "development mailbox sent to other guardian, revoked parent cancelled before send",
        deletion:
          "deny first, one-page interruption, service resume, Auth deleted, other guardian and organization history survive",
      };
    });
  results.passed = true;
} catch (error) {
  results.passed = false;
  results.failure = { code: error.code ?? "ASSERTION", message: error.message };
  throw error;
} finally {
  writeFileSync(output, JSON.stringify(results, null, 2));
  closeSync(output);
  server.close();
  await deleteApp(getApp());
}
