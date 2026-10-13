import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { initializeApp, deleteApp } from "firebase/app";
import {
  getAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
} from "firebase/auth";
import {
  getFunctions,
  connectFunctionsEmulator,
  httpsCallable,
} from "firebase/functions";
import { projectId, requireEmulators } from "./fixtures.mjs";
import csv from "../../shared/csv.ts";
const { parseCsv, safeCsv, MAX_ROWS, MAX_BYTES } = csv;
const require = createRequire(
  new URL("../../functions/package.json", import.meta.url),
);
const {
  initializeApp: adminApp,
  deleteApp: deleteAdmin,
} = require("firebase-admin/app");
const { getAuth: adminAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
requireEmulators();
let app, db;
const clients = {};
let seq = 0;
const orgId = "imports-org",
  programId = "imports-program",
  seasonId = "imports-season",
  teamId = "imports-team";
const meta = {
  schemaVersion: 2,
  revision: 1,
  status: "active",
  orgId,
  createdBy: "imports-owner",
  updatedBy: "imports-owner",
};
const headers =
  "externalId,participantName,kind,teamExternalId,guardianEmail1,guardianEmail2";
const mapping = Object.fromEntries(headers.split(",").map((k) => [k, k]));
const request = (data) => ({ requestId: `imports-request-${++seq}`, ...data });
const call = async (name, data, uid = "imports-owner") =>
  (await httpsCallable(getFunctions(clients[uid]), name)(data)).data;
const load = async (jobId) => await call("getRosterImport", { orgId, jobId });
async function waitFor(jobId, status) {
  for (let i = 0; i < 120; i++) {
    const result = await load(jobId);
    if (status.includes(result.job.status)) return result;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Import ${jobId} did not reach ${status}`);
}
async function upload(lines, extra = {}) {
  return call(
    "uploadRosterImport",
    request({
      orgId,
      programId,
      seasonId,
      templateVersion: 1,
      csvBase64: Buffer.from(`${headers}\r\n${lines}`).toString("base64"),
      mapping,
      ...extra,
    }),
  );
}
async function commit(job) {
  await call(
    "commitRosterImport",
    request({
      orgId,
      jobId: job.id,
      previewRevision: job.previewRevision,
      planRevision: job.planRevision,
      confirmed: true,
    }),
  );
  return waitFor(job.id, ["complete", "needs-review", "paused"]);
}
before(async () => {
  app = adminApp({ projectId });
  db = getFirestore(app);
  for (const uid of ["imports-owner", "imports-staff", "imports-outsider"]) {
    await adminAuth(app).createUser({
      uid,
      email: `${uid}@example.test`,
      password: "SyntheticPassword123!",
    });
    await db.doc(`users/${uid}`).set({ uid, appRole: "user" });
    const client = initializeApp({ projectId, apiKey: "demo-key" }, uid);
    clients[uid] = client;
    connectAuthEmulator(getAuth(client), "http://127.0.0.1:9099", {
      disableWarnings: true,
    });
    connectFunctionsEmulator(getFunctions(client), "127.0.0.1", 5001);
    await signInWithEmailAndPassword(
      getAuth(client),
      `${uid}@example.test`,
      "SyntheticPassword123!",
    );
  }
  await db.doc(`organizations/${orgId}`).set({
    ...meta,
    name: "Import club",
    features: {
      imports: true,
      organizationV2: true,
      adminWorkspace: true,
      households: true,
    },
  });
  await db
    .doc(`organizations/${orgId}/members/imports-owner`)
    .set({ ...meta, roles: ["orgAdmin"], programIds: [] });
  await db
    .doc(`organizations/${orgId}/members/imports-staff`)
    .set({ ...meta, roles: ["programStaff"], programIds: [programId] });
  await db
    .doc(`organizations/${orgId}/programs/${programId}`)
    .set({ ...meta, name: "Soccer" });
  await db
    .doc(`organizations/${orgId}/seasons/${seasonId}`)
    .set({ ...meta, programId, name: "Fall" });
  await db
    .doc(`organizations/${orgId}/divisions/imports-division`)
    .set({ ...meta, programId, seasonId });
  await db.doc(`teams/${teamId}`).set({
    ...meta,
    programId,
    seasonId,
    divisionId: "imports-division",
    externalId: "U12",
    name: "Falcons",
  });
});
after(async () => {
  await Promise.all(Object.values(clients).map(deleteApp));
  await deleteAdmin(app);
});

test("strict CSV parser handles BOM multiline escaped quotes and rejects malformed encoding, shape and limits", () => {
  const encoder = new TextEncoder();
  assert.deepEqual(
    parseCsv(encoder.encode('\uFEFFa,b\r\n"line\nwith ""quote""",x')),
    [
      ["a", "b"],
      ['line\nwith "quote"', "x"],
    ],
  );
  for (const s of [
    "a,b\nx",
    "a,a\nx,y",
    'a,b\n"x,y',
    'a,b\n"x"junk,y',
    'a,b\nx"z,y',
    "a,b\n",
  ])
    assert.throws(() => parseCsv(encoder.encode(s)));
  assert.throws(
    () => parseCsv(new Uint8Array([0x61, 0x0a, 0xc3, 0x28])),
    /UTF-8/,
  );
  assert.throws(() => parseCsv(new Uint8Array(MAX_BYTES + 1)), /5 MB/);
  assert.throws(
    () =>
      parseCsv(
        encoder.encode(
          "a\n" +
            Array(MAX_ROWS + 1)
              .fill("b")
              .join("\n"),
        ),
      ),
    /5,000/,
  );
  assert.match(
    safeCsv([['=HYPERLINK("bad")', "+123", "normal"]]),
    /"'=HYPERLINK/,
  );
  assert.equal(
    readFileSync("shared/csv.ts", "utf8"),
    readFileSync("functions/src/imports/csv.ts", "utf8"),
    "browser/server parser contract must match",
  );
});
test("private upload rechecks scope, rejects invalid UTF-8, duplicate columns and reused upload identity", async () => {
  await assert.rejects(
    upload("one,Jamie,youth,U12,,", {
      csvBase64: Buffer.from([0xff]).toString("base64"),
    }),
    { code: "functions/invalid-argument" },
  );
  await assert.rejects(
    call(
      "uploadRosterImport",
      request({
        orgId,
        programId,
        seasonId,
        templateVersion: 1,
        csvBase64: Buffer.from(`${headers}\none,Jamie,youth,U12,,`).toString(
          "base64",
        ),
        mapping,
      }),
      "imports-outsider",
    ),
    { code: "functions/permission-denied" },
  );
  const payload = request({
    orgId,
    programId,
    seasonId,
    templateVersion: 1,
    csvBase64: Buffer.from(
      `${headers}\nidempotent,Idempotent,youth,U12,,`,
    ).toString("base64"),
    mapping,
  });
  const initial = await call("uploadRosterImport", payload);
  const replay = await call("uploadRosterImport", payload);
  assert.equal(initial.job.id, replay.job.id);
  await assert.rejects(
    call("uploadRosterImport", {
      ...payload,
      csvBase64: Buffer.from(
        `${headers}\nchanged,Changed,youth,U12,,`,
      ).toString("base64"),
    }),
    { code: "functions/already-exists" },
  );
  const { initializeTestEnvironment, assertFails } =
    await import("@firebase/rules-unit-testing");
  const { doc, getDoc } = await import("firebase/firestore");
  const env = await initializeTestEnvironment({
    projectId,
    firestore: {
      host: "127.0.0.1",
      port: 8080,
      rules: readFileSync("firestore.rules", "utf8"),
    },
  });
  try {
    await assertFails(
      getDoc(
        doc(
          env.authenticatedContext("imports-owner").firestore(),
          `importJobs/${initial.job.id}`,
        ),
      ),
    );
  } finally {
    await env.cleanup();
  }
});
test("preview writes no identities, exact duplicate IDs require explicit skip and guardian emails grant nothing", async () => {
  const baseline = (
    await db.collection(`organizations/${orgId}/participants`).get()
  ).size;
  const { job } = await upload(
    'dup,Jamie,youth,U12,parent@example.test,\ndup,Jamie,youth,U12,parent@example.test,\nvalid,"Casey\nExample",youth,U12,parent@example.test,',
  );
  const preview = await waitFor(job.id, ["preview"]);
  assert.equal(preview.job.unresolved, 2);
  assert.equal(preview.job.previewCreates, 1);
  assert.equal(
    (await db.collection(`organizations/${orgId}/participants`).get()).size,
    baseline,
  );
  assert.ok(
    preview.rows
      .slice(0, 2)
      .every((r) => r.errors.some((e) => e.includes("Repeated"))),
  );
  await assert.rejects(commit(preview.job), {
    code: "functions/invalid-argument",
  });
  for (const number of [1, 2])
    await call(
      "resolveRosterImportRow",
      request({
        orgId,
        jobId: job.id,
        number,
        previewRevision: 1,
        planRevision: (await load(job.id)).job.planRevision,
        resolution: "skip",
      }),
    );
  const done = await commit((await load(job.id)).job);
  assert.equal(done.job.status, "complete");
  assert.equal(done.job.created, 1);
  assert.equal(done.job.skipped, 2);
  assert.equal(done.job.previewSkips, 2);
  const p = done.rows[2].participantId;
  assert.equal(
    (
      await db
        .doc(`organizations/${orgId}/participants/${p}`)
        .collection("guardians")
        .get()
    ).size,
    0,
  );
  assert.equal(
    (await db.collection("emailOutbox").where("participantId", "==", p).get())
      .size,
    0,
  );
  const count = (
    await db.collection(`organizations/${orgId}/participants`).get()
  ).size;
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(
    (await db.collection(`organizations/${orgId}/participants`).get()).size,
    count,
  );
});
test("normalized same-name identities require explicit match or separate creation; reimport external ID updates stable identity", async () => {
  await db.doc(`organizations/${orgId}/participants/older-name`).set({
    ...meta,
    displayName: "Jamie   Example",
    kind: "youth",
    linkedUserId: null,
  });
  const { job } = await upload(", Jamie Example ,youth,U12,,");
  const preview = await waitFor(job.id, ["preview"]);
  assert.equal(preview.job.unresolved, 1);
  assert.equal(preview.rows[0].candidates[0].id, "older-name");
  await call(
    "resolveRosterImportRow",
    request({
      orgId,
      jobId: job.id,
      number: 1,
      previewRevision: 1,
      planRevision: (await load(job.id)).job.planRevision,
      resolution: "create",
    }),
  );
  const done = await commit((await load(job.id)).job);
  assert.equal(done.job.created, 1);
  assert.notEqual(done.rows[0].participantId, "older-name");
  const first = await upload("trusted,Original,youth,U12,,");
  const completed = await commit(
    (await waitFor(first.job.id, ["preview"])).job,
  );
  const next = await upload("trusted,Updated,youth,U12,,");
  const p = await waitFor(next.job.id, ["preview"]);
  assert.equal(p.rows[0].resolution, "update");
  assert.equal(p.rows[0].participantId, completed.rows[0].participantId);
  const updated = await commit(p.job);
  assert.equal(updated.job.updated, 1);
  assert.equal(
    (
      await db
        .doc(
          `organizations/${orgId}/participants/${updated.rows[0].participantId}`,
        )
        .get()
    ).data().displayName,
    "Updated",
  );
});
test("stale second row stops after visible partial progress; refresh resumes pending rows without duplicating completed rows", async () => {
  const first = await upload(
    "partial-a,A,youth,U12,,\npartial-b,B,youth,U12,,",
  );
  const p = await waitFor(first.job.id, ["preview"]);
  await db
    .doc(`organizations/${orgId}/participants/${p.rows[1].participantId}`)
    .set({
      ...meta,
      displayName: "Concurrent edit",
      kind: "youth",
      externalId: "partial-b",
      linkedUserId: null,
    });
  const stopped = await commit(p.job);
  assert.equal(stopped.job.status, "needs-review");
  assert.equal(stopped.job.checkpoint, 1);
  assert.equal(stopped.job.created, 1);
  assert.match(stopped.job.error, /changed/);
  await call("refreshRosterImport", request({ orgId, jobId: first.job.id }));
  const refreshed = await waitFor(first.job.id, ["preview"]);
  assert.equal(refreshed.job.previewRevision, 2);
  assert.equal(refreshed.rows[0].outcome, "created");
  assert.equal(refreshed.rows[1].resolution, "update");
  const done = await commit(refreshed.job);
  assert.equal(done.job.created, 1);
  assert.equal(done.job.updated, 1);
  assert.equal(done.job.checkpoint, 2);
});
test("mid-import canonical revocation and deleted account fence worker; restored owner can review and resume", async () => {
  const { job } = await upload("revoke-one,Revocation,youth,U12,,");
  const p = await waitFor(job.id, ["preview"]);
  // Force an expired worker lease to make revocation deterministic before any pending row executes.
  await db.doc(`importJobs/${job.id}`).update({
    lease: "test-hold",
    leaseUntil: Timestamp.fromMillis(Date.now() + 60000),
  });
  await db
    .doc(`organizations/${orgId}/members/imports-owner`)
    .update({ status: "revoked" });
  const stored = (await db.doc(`importJobs/${job.id}`).get()).data();
  await db.doc(`importJobs/${job.id}`).update({
    status: "committing",
    confirmedBinding: stored.binding,
    confirmedPreviewRevision: 1,
    confirmedPlanRevision: stored.planRevision,
  });
  await assert.rejects(load(job.id), { code: "functions/permission-denied" });
  // Service worker uses live owner authority, independently of the callable token.
  const { runRosterImport } = require("./lib/imports/roster.js");
  await db.doc(`importJobs/${job.id}`).update({ lease: null });
  await runRosterImport(job.id);
  assert.equal(
    (await db.doc(`importJobs/${job.id}`).get()).data().status,
    "paused",
  );
  assert.equal(
    (
      await db
        .doc(`organizations/${orgId}/participants/${p.rows[0].participantId}`)
        .get()
    ).exists,
    false,
  );
  await db
    .doc(`organizations/${orgId}/members/imports-owner`)
    .update({ status: "active" });
  await call("refreshRosterImport", request({ orgId, jobId: job.id }));
  const again = await waitFor(job.id, ["preview"]);
  assert.equal((await commit(again.job)).job.status, "complete");
});

test("staff enrollment preserves identity and rejects new or foreign identity creation and disabled rollout", async () => {
  const csvBase64 = Buffer.from(
    `${headers}\ntrusted,Attempted rename,youth,U12,,`,
  ).toString("base64");
  const uploaded = await call(
    "uploadRosterImport",
    request({
      orgId,
      programId,
      seasonId,
      templateVersion: 1,
      csvBase64,
      mapping,
    }),
    "imports-staff",
  );
  async function staffWait(id) {
    for (let i = 0; i < 100; i++) {
      const r = await call(
        "getRosterImport",
        { orgId, jobId: id },
        "imports-staff",
      );
      if (r.job.status === "preview") return r;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("staff preview timeout");
  }
  const preview = await staffWait(uploaded.job.id);
  assert.equal(preview.rows[0].resolution, "update");
  const participantId = preview.rows[0].participantId;
  const before = (
    await db.doc(`organizations/${orgId}/participants/${participantId}`).get()
  ).data();
  await call(
    "commitRosterImport",
    request({
      orgId,
      jobId: uploaded.job.id,
      previewRevision: 1,
      planRevision: preview.job.planRevision,
      confirmed: true,
    }),
    "imports-staff",
  );
  for (let i = 0; i < 100; i++) {
    const r = await call(
      "getRosterImport",
      { orgId, jobId: uploaded.job.id },
      "imports-staff",
    );
    if (r.job.status === "complete") break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const after = (
    await db.doc(`organizations/${orgId}/participants/${participantId}`).get()
  ).data();
  assert.equal(after.displayName, before.displayName);
  assert.equal(after.kind, before.kind);
  assert.equal(after.externalId, before.externalId);
  const fresh = await call(
    "uploadRosterImport",
    request({
      orgId,
      programId,
      seasonId,
      templateVersion: 1,
      csvBase64: Buffer.from(`${headers}\nnew-staff,New,youth,U12,,`).toString(
        "base64",
      ),
      mapping,
    }),
    "imports-staff",
  );
  const blocked = await staffWait(fresh.job.id);
  assert.equal(blocked.job.unresolved, 1);
  assert.ok(blocked.rows[0].errors.some((e) => e.includes("administrator")));
  await assert.rejects(
    call("getRosterImport", { orgId, jobId: fresh.job.id }, "imports-owner"),
    { code: "functions/permission-denied" },
  );
  await db.doc(`organizations/${orgId}`).update({ "features.imports": false });
  await assert.rejects(upload("off,Disabled,youth,U12,,"), {
    code: "functions/permission-denied",
  });
  await db.doc(`organizations/${orgId}`).update({ "features.imports": true });
});

test("Storage denies direct source reads/writes; retention removes private source and nested rows but preserves committed identities", async () => {
  const { job } = await upload("retention-child,Retention,youth,U12,,");
  const preview = await waitFor(job.id, ["preview"]);
  const done = await commit(preview.job);
  const { getStorage: adminStorage } = require("firebase-admin/storage");
  const bucket = adminStorage(app).bucket(`${projectId}.appspot.com`);
  const file = bucket.file(`imports/${orgId}/${job.id}/source.csv`);
  assert.equal((await file.exists())[0], true);
  const { getStorage, connectStorageEmulator, ref, getBytes, uploadBytes } =
    await import("firebase/storage");
  const storage = getStorage(
    clients["imports-owner"],
    `gs://${projectId}.appspot.com`,
  );
  connectStorageEmulator(storage, "127.0.0.1", 9199);
  await assert.rejects(
    getBytes(ref(storage, `imports/${orgId}/${job.id}/source.csv`)),
    { code: "storage/unauthorized" },
  );
  await assert.rejects(
    uploadBytes(
      ref(storage, `imports/${orgId}/${job.id}/source.csv`),
      new Uint8Array([1]),
    ),
    { code: "storage/unauthorized" },
  );
  await db
    .doc(`importJobs/${job.id}`)
    .update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
  const { expireRosterImports } = require("./lib/imports/roster.js");
  await expireRosterImports.run({});
  assert.equal((await file.exists())[0], false);
  assert.equal((await db.doc(`importJobs/${job.id}`).get()).exists, false);
  assert.equal(
    (await db.collection(`importJobs/${job.id}/rows`).get()).size,
    0,
  );
  assert.equal(
    (
      await db
        .doc(
          `organizations/${orgId}/participants/${done.rows[0].participantId}`,
        )
        .get()
    ).exists,
    true,
  );
});

test("completed commit and upload receipts survive archival but recheck revocation", async () => {
  const payload = request({
    orgId,
    programId,
    seasonId,
    templateVersion: 1,
    csvBase64: Buffer.from(
      `${headers}\narchival-replay,Archived receipt,youth,U12,,`,
    ).toString("base64"),
    mapping,
  });
  const { job } = await call("uploadRosterImport", payload);
  const preview = await waitFor(job.id, ["preview"]);
  const confirmed = request({
    orgId,
    jobId: job.id,
    previewRevision: preview.job.previewRevision,
    planRevision: preview.job.planRevision,
    confirmed: true,
  });
  const result = await call("commitRosterImport", confirmed);
  await waitFor(job.id, ["complete"]);
  await db
    .doc(`organizations/${orgId}/seasons/${seasonId}`)
    .update({ status: "archived" });
  assert.deepEqual(await call("commitRosterImport", confirmed), result);
  assert.equal((await call("uploadRosterImport", payload)).job.id, job.id);
  await db
    .doc(`organizations/${orgId}/members/imports-owner`)
    .update({ status: "revoked" });
  await assert.rejects(call("commitRosterImport", confirmed), {
    code: "functions/permission-denied",
  });
  await db
    .doc(`organizations/${orgId}/members/imports-owner`)
    .update({ status: "active" });
  await db
    .doc(`organizations/${orgId}/seasons/${seasonId}`)
    .update({ status: "active" });
});

async function resolve(jobId, number, resolution, participantId) {
  const { job } = await load(jobId);
  return call(
    "resolveRosterImportRow",
    request({
      orgId,
      jobId,
      number,
      previewRevision: job.previewRevision,
      planRevision: job.planRevision,
      resolution,
      ...(participantId ? { participantId } : {}),
    }),
  );
}

test("another tab changing a resolution invalidates old plan confirmation without writing identities", async () => {
  const { job } = await upload("plan-fence,Plan fence,youth,U12,,");
  const initial = await waitFor(job.id, ["preview"]);
  const staleConfirmation = request({
    orgId,
    jobId: job.id,
    previewRevision: 1,
    planRevision: initial.job.planRevision,
    confirmed: true,
  });
  await resolve(job.id, 1, "skip");
  await resolve(job.id, 1, "create");
  assert.equal(
    (await load(job.id)).job.planRevision,
    initial.job.planRevision + 2,
  );
  await assert.rejects(call("commitRosterImport", staleConfirmation), {
    code: "functions/invalid-argument",
  });
  assert.equal(
    (
      await db
        .doc(
          `organizations/${orgId}/participants/${initial.rows[0].participantId}`,
        )
        .get()
    ).exists,
    false,
  );
  assert.equal((await commit((await load(job.id)).job)).job.status, "complete");
});
test("team matching scopes season and active status; invalid divisions and foreign-season rows are skippable errors", async () => {
  const base = (await db.doc(`teams/${teamId}`).get()).data();
  await db
    .doc("teams/imports-other-season")
    .set({ ...base, seasonId: "another-season" });
  await db
    .doc("teams/imports-archived-copy")
    .set({ ...base, status: "archived" });
  await db
    .doc("teams/imports-bad-division")
    .set({ ...base, externalId: "BAD", divisionId: "missing-division" });
  await db
    .doc("teams/imports-foreign-only")
    .set({ ...base, externalId: "FOREIGN", seasonId: "another-season" });
  const { job } = await upload(
    "scoped-match,Selected season,youth,U12,,\ninvalid-division,Bad division,youth,BAD,,\nforeign-season,Foreign season,youth,FOREIGN,,",
  );
  const preview = await waitFor(job.id, ["preview"]);
  assert.equal(preview.rows[0].resolution, "create");
  assert.equal(preview.rows[0].teamId, teamId);
  assert.equal(preview.job.unresolved, 2);
  assert.ok(preview.rows[1].errors.some((e) => e.includes("division")));
  assert.ok(
    preview.rows[2].errors.some((e) =>
      e.includes("selected program and season"),
    ),
  );
  for (const number of [2, 3]) await resolve(job.id, number, "skip");
  const done = await commit((await load(job.id)).job);
  assert.equal(done.job.created, 1);
  assert.equal(done.job.skipped, 2);
});
test("two explicit matches enroll one participant on two teams in one commit without treating own revision as stale", async () => {
  const base = (await db.doc(`teams/${teamId}`).get()).data();
  await db
    .doc("teams/imports-second-team")
    .set({ ...base, externalId: "SECOND" });
  await db
    .doc(`organizations/${orgId}/participants/imports-multi-enrollment`)
    .set({
      ...meta,
      displayName: "Multi enrollment",
      kind: "youth",
      linkedUserId: null,
    });
  const { job } = await upload(
    ",Multi enrollment,youth,U12,,\n,Multi enrollment,youth,SECOND,,",
  );
  const preview = await waitFor(job.id, ["preview"]);
  assert.equal(preview.job.unresolved, 2);
  for (const number of [1, 2])
    await resolve(job.id, number, "update", "imports-multi-enrollment");
  const done = await commit((await load(job.id)).job);
  assert.equal(done.job.status, "complete");
  assert.equal(done.job.updated, 2);
  assert.equal(done.job.checkpoint, 2);
  for (const team of [teamId, "imports-second-team"])
    assert.equal(
      (
        await db.doc(`teams/${team}/roster/imports-multi-enrollment`).get()
      ).data().status,
      "active",
    );
  assert.equal(
    (
      await db
        .doc(`organizations/${orgId}/participants/imports-multi-enrollment`)
        .get()
    ).data().revision,
    3,
  );
});
test("retention drains more than one bounded page per run", async () => {
  const ids = Array.from({ length: 28 }, (_, n) => `imports-expired-bulk-${n}`);
  const batch = db.batch();
  for (const id of ids)
    batch.set(db.doc(`importJobs/${id}`), {
      id,
      orgId,
      status: "preview",
      ownerUid: "imports-owner",
      expiresAt: Timestamp.fromMillis(Date.now() - 1000),
    });
  await batch.commit();
  const { getStorage } = require("firebase-admin/storage");
  const file = getStorage(app)
    .bucket(`${projectId}.appspot.com`)
    .file(`imports/${orgId}/${ids[27]}/source.csv`);
  await file.save("Synthetic expired source");
  const { cleanupExpiredRosterImports } = require("./lib/imports/roster.js");
  const result = await cleanupExpiredRosterImports();
  assert.ok(result.removed >= 28);
  assert.equal(result.failed, 0);
  for (const id of ids)
    assert.equal((await db.doc(`importJobs/${id}`).get()).exists, false);
  assert.equal((await file.exists())[0], false);
});
