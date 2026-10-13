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
const orgId = "schedules-org",
  programId = "schedules-program",
  seasonId = "schedules-season",
  teamId = "schedules-team";
const meta = {
  schemaVersion: 2,
  revision: 1,
  status: "active",
  orgId,
  createdBy: "schedules-owner",
  updatedBy: "schedules-owner",
};
const headers =
  "externalId,teamExternalId,eventType,title,localDate,localStartTime,localEndTime,timeZone,startOffset,endOffset,locationName,address,notes";
const mapping = Object.fromEntries(headers.split(",").map((k) => [k, k]));
const request = (data) => ({
  requestId: `schedules-request-${++seq}`,
  ...data,
});
const call = async (name, data, uid = "schedules-owner") =>
  (await httpsCallable(getFunctions(clients[uid]), name)(data)).data;
const load = async (jobId) => await call("getScheduleImport", { orgId, jobId });
async function waitFor(jobId, status) {
  for (let i = 0; i < 120; i++) {
    try {
      const result = await load(jobId);
      if (status.includes(result.job.status)) return result;
    } catch (error) {
      // Polling reads can recover from transient emulator transport/transaction failures.
      if (
        ![
          "functions/internal",
          "functions/unavailable",
          "functions/deadline-exceeded",
        ].includes(error.code)
      )
        throw error;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Import ${jobId} did not reach ${status}`);
}
async function upload(lines, extra = {}) {
  return call(
    "uploadScheduleImport",
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
    "commitScheduleImport",
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
  for (const uid of [
    "schedules-owner",
    "schedules-staff",
    "schedules-outsider",
  ]) {
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
    .doc(`organizations/${orgId}/members/schedules-owner`)
    .set({ ...meta, roles: ["orgAdmin"], programIds: [] });
  await db
    .doc(`organizations/${orgId}/members/schedules-staff`)
    .set({ ...meta, roles: ["programStaff"], programIds: [programId] });
  await db
    .doc(`organizations/${orgId}/programs/${programId}`)
    .set({ ...meta, name: "Soccer" });
  await db
    .doc(`organizations/${orgId}/seasons/${seasonId}`)
    .set({ ...meta, programId, name: "Fall" });
  await db
    .doc(`organizations/${orgId}/divisions/schedules-division`)
    .set({ ...meta, programId, seasonId });
  await db.doc(`teams/${teamId}`).set({
    ...meta,
    programId,
    seasonId,
    divisionId: "schedules-division",
    externalId: "U12",
    name: "Falcons",
  });
});
after(async () => {
  await Promise.all(Object.values(clients).map(deleteApp));
  await deleteAdmin(app);
});

const line = (
  external,
  title = "Practice",
  date = "2026-10-20",
  start = "17:00",
  end = "18:00",
  startOffset = "",
  endOffset = "",
) =>
  [
    external,
    "U12",
    "practice",
    title,
    date,
    start,
    end,
    "America/Chicago",
    startOffset,
    endOffset,
    "Park field",
    "",
    "",
  ].join(",");
const resolveRow = async (job, number, resolution) =>
  call(
    "resolveScheduleImportRow",
    request({
      orgId,
      jobId: job.id,
      number,
      previewRevision: job.previewRevision,
      planRevision: job.planRevision,
      resolution,
    }),
  );
const prepare = async (job, numbers = [1]) =>
  call("prepareSchedulePublication", { orgId, jobId: job.id, numbers });
const publish = async (job, review, numbers = [1], extra = {}) =>
  call(
    "publishScheduleImport",
    request({
      orgId,
      jobId: job.id,
      numbers,
      binding: review.binding,
      confirmed: true,
      ...extra,
    }),
  );
test("schedule DST fold and gap block drafts; valid offsets select real instants", async () => {
  const { job } = await upload(
    [
      line("fold", "Fall fold", "2026-11-01", "01:15", "02:15"),
      line("gap", "Spring gap", "2026-03-08", "02:15", "03:15"),
      line(
        "offset",
        "Reviewed fold",
        "2026-11-01",
        "01:15",
        "02:15",
        "-05:00",
        "-06:00",
      ),
      line(
        "bad-offset",
        "Wrong offset",
        "2026-11-01",
        "01:15",
        "02:15",
        "-04:00",
        "-06:00",
      ),
    ].join("\n"),
  );
  const preview = await waitFor(job.id, ["preview"]);
  assert.equal(preview.job.unresolved, 3);
  assert.match(preview.rows[0].errors.join(" "), /Ambiguous/);
  assert.match(preview.rows[1].errors.join(" "), /Nonexistent/);
  assert.match(preview.rows[3].errors.join(" "), /Offset does not match/);
  await assert.rejects(commit(preview.job), {
    code: "functions/invalid-argument",
  });
  for (const number of [1, 2, 4])
    await resolveRow((await load(job.id)).job, number, "skip");
  const done = await commit((await load(job.id)).job);
  assert.equal(done.job.created, 1);
  assert.equal(done.job.skipped, 3);
  const event = (await db.doc(`events/${done.rows[2].eventId}`).get()).data();
  assert.equal(
    event.startsAt.toDate().toISOString(),
    "2026-11-01T06:15:00.000Z",
  );
  assert.equal(event.publicationState, "staged");
});
test("draft commit retries preserve identity and staged events stay out of household agenda and ICS", async () => {
  const uid = "schedules-household";
  await adminAuth(app).createUser({
    uid,
    email: `${uid}@example.test`,
    emailVerified: true,
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
  await db
    .doc(`organizations/${orgId}/participants/schedule-child`)
    .set({ ...meta, displayName: "Jamie", kind: "youth", linkedUserId: null });
  await db
    .doc(`organizations/${orgId}/participants/schedule-child/guardians/${uid}`)
    .set({
      ...meta,
      userId: uid,
      participantId: "schedule-child",
      permissions: { viewSchedule: true },
    });
  await db
    .doc(`teams/${teamId}/roster/schedule-child`)
    .set({ ...meta, participantId: "schedule-child" });
  await db
    .doc(`users/${uid}/participantLinks/${orgId}_schedule-child`)
    .set({ orgId, participantId: "schedule-child", status: "active" });
  const { job } = await upload(line("stable-event", "Stable ID"));
  const preview = await waitFor(job.id, ["preview"]);
  const payload = request({
    orgId,
    jobId: job.id,
    previewRevision: preview.job.previewRevision,
    planRevision: preview.job.planRevision,
    confirmed: true,
  });
  await Promise.all([
    call("commitScheduleImport", payload),
    call("commitScheduleImport", payload),
  ]);
  const done = await waitFor(job.id, ["complete"]);
  const agendaPayload = {
    from: "2026-10-20T00:00:00.000Z",
    to: "2026-10-21T00:00:00.000Z",
  };
  assert.equal(
    (await call("listHouseholdAgenda", agendaPayload, uid)).items.length,
    0,
  );
  await db
    .doc(`organizations/${orgId}`)
    .update({ "features.calendarSubscriptions": true });
  const feed = await call(
    "createCalendarSubscription",
    request({
      participantRefs: [{ orgId, participantId: "schedule-child" }],
      teamIds: [teamId],
      eventTypes: ["practice", "match"],
      includeParticipantNames: false,
    }),
    uid,
  );
  const response = await fetch(feed.url);
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.ok(!body.includes("Stable ID"));
  const review = await prepare(done.job);
  assert.equal(review.recipientCount, 1);
  const publishPayload = request({
    orgId,
    jobId: job.id,
    numbers: [1],
    binding: review.binding,
    confirmed: true,
  });
  const results = await Promise.all([
    call("publishScheduleImport", publishPayload),
    call("publishScheduleImport", publishPayload),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].queued, 1);
  assert.equal(
    (await call("listHouseholdAgenda", agendaPayload, uid)).items.length,
    1,
  );
  assert.match(await (await fetch(feed.url)).text(), /Stable ID/);
  const outbox = await db
    .collection("emailOutbox")
    .where("eventId", "==", done.rows[0].eventId)
    .get();
  assert.equal(outbox.size, 1);
  assert.equal(outbox.docs[0].data().eventRevision, 2);
  await assert.rejects(publish(done.job, review), {
    code: "functions/aborted",
  });
  const updatedJob = (
    await upload(
      line("stable-event", "Moved practice", "2026-10-20", "18:00", "19:00"),
    )
  ).job;
  const updatePreview = await waitFor(updatedJob.id, ["preview"]);
  assert.equal(updatePreview.rows[0].resolution, "update");
  assert.equal(updatePreview.rows[0].eventId, done.rows[0].eventId);
  const updated = await commit(updatePreview.job);
  assert.equal(updated.rows[0].eventId, done.rows[0].eventId);
  assert.equal(
    (await call("listHouseholdAgenda", agendaPayload, uid)).items.length,
    0,
  );
  const secondReview = await prepare(updated.job);
  await publish(updated.job, secondReview);
  assert.equal(
    (
      await db
        .collection("emailOutbox")
        .where("eventId", "==", done.rows[0].eventId)
        .get()
    ).size,
    2,
  );
  assert.equal(
    (await db.doc(`events/${done.rows[0].eventId}`).get()).data().revision,
    4,
  );
});
test("publication rejects stale draft and recipient confirmations, revoked scope and missing explicit consent", async () => {
  const { job } = await upload(line("stale-publish", "Stale publication"));
  const done = await commit((await waitFor(job.id, ["preview"])).job),
    review = await prepare(done.job);
  await assert.rejects(publish(done.job, review, [1], { confirmed: false }), {
    code: "functions/invalid-argument",
  });
  await db
    .doc(
      `organizations/${orgId}/participants/schedule-child/guardians/schedules-household`,
    )
    .update({ status: "revoked" });
  await assert.rejects(publish(done.job, review), {
    code: "functions/aborted",
  });
  await db
    .doc(
      `organizations/${orgId}/participants/schedule-child/guardians/schedules-household`,
    )
    .update({ status: "active" });
  await db
    .doc(`events/${done.rows[0].eventId}`)
    .update({ revision: 2, title: "Outside edit" });
  await assert.rejects(publish(done.job, review), {
    code: "functions/aborted",
  });
  await db
    .doc(`organizations/${orgId}/members/schedules-owner`)
    .update({ status: "revoked" });
  await assert.rejects(prepare(done.job), {
    code: "functions/permission-denied",
  });
  await db
    .doc(`organizations/${orgId}/members/schedules-owner`)
    .update({ status: "active" });
  assert.equal(
    (await db.doc(`events/${done.rows[0].eventId}`).get()).data()
      .publicationState,
    "staged",
  );
});
test("schedule source and existing overlaps warn, duplicate IDs require skips and name-only reruns need review", async () => {
  const { job } = await upload(
    [
      line("overlap-one", "Overlap A", "2026-10-20", "18:00", "19:00"),
      line("overlap-two", "Overlap B", "2026-10-20", "18:30", "19:30"),
      line("duplicate", "Duplicate"),
      line("duplicate", "Duplicate"),
    ].join("\n"),
  );
  const preview = await waitFor(job.id, ["preview"]);
  assert.ok(preview.rows[0].warnings.some((w) => w.includes("existing event")));
  assert.ok(preview.rows[1].warnings.some((w) => w.includes("source row")));
  assert.equal(preview.job.unresolved, 2);
  for (const n of [3, 4]) await resolveRow((await load(job.id)).job, n, "skip");
  await commit((await load(job.id)).job);
  const first = (await upload(line("", "Untrusted same title"))).job;
  await commit((await waitFor(first.id, ["preview"])).job);
  const second = (await upload(line("", "Untrusted same title"))).job;
  const ambiguous = await waitFor(second.id, ["preview"]);
  assert.equal(ambiguous.job.unresolved, 1);
  assert.equal(ambiguous.rows[0].resolution, null);
  await resolveRow(ambiguous.job, 1, "create");
  const done = await commit((await load(second.id)).job);
  assert.equal(done.job.created, 1);
});
test("schedule confirmations cannot use roster jobs and stale previews never overwrite an outside event edit", async () => {
  const { job } = await upload(line("stale-draft", "Outside draft edit"));
  const preview = await waitFor(job.id, ["preview"]);
  await assert.rejects(call("getRosterImport", { orgId, jobId: job.id }), {
    code: "functions/permission-denied",
  });
  await db.doc(`events/${preview.rows[0].eventId}`).set({
    ...meta,
    orgId,
    programId,
    seasonId,
    teamId,
    teamIds: [teamId],
    revision: 1,
    title: "Outside insertion",
  });
  const stopped = await commit(preview.job);
  assert.equal(stopped.job.status, "needs-review");
  assert.equal(
    (await db.doc(`events/${preview.rows[0].eventId}`).get()).data().title,
    "Outside insertion",
  );
});

test("schedule template stays identical across isolated browser and Functions bundles", () => {
  assert.equal(
    readFileSync("shared/scheduleColumns.ts", "utf8"),
    readFileSync("functions/src/imports/scheduleColumns.ts", "utf8"),
  );
});

test("publication deduplicates siblings and scopes verified contacts without granting imported access", async () => {
  for (const [uid, verified] of [
    ["schedules-second", true],
    ["schedules-unverified", false],
    ["schedules-deleted", true],
  ]) {
    await adminAuth(app).createUser({
      uid,
      email: `${uid}@example.test`,
      emailVerified: verified,
    });
    await db.doc(`users/${uid}`).set({
      uid,
      appRole: "user",
      ...(uid === "schedules-deleted" ? { accountState: "deleting" } : {}),
    });
  }
  const child = "schedule-sibling";
  await db
    .doc(`organizations/${orgId}/participants/${child}`)
    .set({ ...meta, displayName: "Casey", kind: "youth", linkedUserId: null });
  await db
    .doc(`teams/${teamId}/roster/${child}`)
    .set({ ...meta, participantId: child });
  for (const target of [
    "schedules-household",
    "schedules-second",
    "schedules-unverified",
    "schedules-deleted",
  ])
    await db
      .doc(`organizations/${orgId}/participants/${child}/guardians/${target}`)
      .set({
        ...meta,
        userId: target,
        participantId: child,
        permissions: { viewSchedule: true },
      });
  await db
    .doc(
      `organizations/${orgId}/participants/${child}/guardians/schedules-outsider`,
    )
    .set({
      ...meta,
      userId: "schedules-outsider",
      participantId: child,
      permissions: { viewSchedule: false },
    });
  const { job } = await upload(line("recipient-scope", "Verified scope"));
  const done = await commit((await waitFor(job.id, ["preview"])).job),
    review = await prepare(done.job);
  assert.equal(review.recipientCount, 2);
  assert.ok(!JSON.stringify(review).includes("@example.test"));
  const result = await publish(done.job, review);
  assert.equal(result.queued, 2);
  const queues = await db
    .collection("emailOutbox")
    .where("eventId", "==", done.rows[0].eventId)
    .get();
  assert.deepEqual(queues.docs.map((d) => d.data().recipientUid).sort(), [
    "schedules-household",
    "schedules-second",
  ]);
  assert.ok(
    queues.docs.every(
      (d) =>
        d.data().status === "queued" && d.data().transportMessageId === null,
    ),
  );
});
test("concurrent schedule jobs with one external identity cannot create duplicate events", async () => {
  const [one, two] = await Promise.all([
    upload(line("concurrent-identity", "Concurrent schedule")),
    upload(line("concurrent-identity", "Concurrent schedule")),
  ]);
  const previews = await Promise.all([
    waitFor(one.job.id, ["preview"]),
    waitFor(two.job.id, ["preview"]),
  ]);
  assert.equal(previews[0].rows[0].eventId, previews[1].rows[0].eventId);
  const outcomes = await Promise.all(previews.map((p) => commit(p.job)));
  assert.deepEqual(outcomes.map((o) => o.job.status).sort(), [
    "complete",
    "needs-review",
  ]);
  assert.equal(
    (
      await db
        .collection("events")
        .where("orgId", "==", orgId)
        .where("externalId", "==", "concurrent-identity")
        .get()
    ).size,
    1,
  );
});

test("multi-event publication resolves each team's verified contacts once per transaction and rechecks on the next call", async () => {
  const { job } = await upload(
    [
      line("batch-contacts-a", "Batch contacts A"),
      line("batch-contacts-b", "Batch contacts B"),
    ].join("\n"),
  );
  const done = await commit((await waitFor(job.id, ["preview"])).job);
  const {
    prepareSchedulePublication,
  } = require("./lib/imports/publication.js");
  const auth = adminAuth(app),
    original = auth.getUsers.bind(auth);
  let batches = 0;
  auth.getUsers = async (identifiers) => {
    batches++;
    return original(identifiers);
  };
  try {
    const review = await prepareSchedulePublication.run({
      auth: { uid: "schedules-owner" },
      data: { orgId, jobId: job.id, numbers: [1, 2] },
    });
    assert.equal(review.events.length, 2);
    assert.equal(review.recipientCount, 4);
    assert.equal(batches, 1);
    await db
      .doc(
        `organizations/${orgId}/participants/schedule-sibling/guardians/schedules-second`,
      )
      .update({ status: "revoked" });
    const refreshed = await prepareSchedulePublication.run({
      auth: { uid: "schedules-owner" },
      data: { orgId, jobId: job.id, numbers: [1, 2] },
    });
    assert.equal(refreshed.recipientCount, 2);
    assert.equal(batches, 2);
    assert.notEqual(refreshed.binding, review.binding);
  } finally {
    auth.getUsers = original;
  }
});
