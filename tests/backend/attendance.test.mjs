import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
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
import {
  getFirestore as clientDb,
  connectFirestoreEmulator,
  doc,
  getDoc,
  setDoc,
} from "firebase/firestore";
import { projectId, requireEmulators } from "./fixtures.mjs";
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
let admin,
  db,
  seq = 0;
const apps = {};
const call = async (uid, name, data = {}) =>
  (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const req = (payload) => ({ requestId: `p210-${++seq}`, ...payload });
const deny = (promise) =>
  assert.rejects(promise, { code: "functions/permission-denied" });
const scope = {
  orgId: "p210-org",
  programId: "p210-program",
  seasonId: "p210-season",
  divisionId: "p210-division",
};
const meta = {
  schemaVersion: 2,
  revision: 1,
  status: "active",
  createdAt: Timestamp.now(),
  updatedAt: Timestamp.now(),
};
const part = (p) => `organizations/p210-org/participants/${p}`;
const grant = (p, u) => `${part(p)}/guardians/${u}`;
const read = (e, uid = "p210-coach", extra = {}) =>
  call(uid, "getEventAttendance", {
    eventId: e.id,
    teamId: "p210-a",
    ...extra,
  });
async function create(extra = {}) {
  return call(
    "p210-admin",
    "createEvent",
    req({
      teamId: "p210-a",
      event: {
        title: "Synthetic sibling match",
        type: "match",
        teamIds: ["p210-a", "p210-b"],
        startsAt: "2026-12-20T23:00:00.000Z",
        endsAt: "2026-12-21T00:00:00.000Z",
        timeZone: "America/Chicago",
        status: "scheduled",
        publicationState: "published",
        ...extra,
      },
    }),
  );
}
before(async () => {
  admin = adminApp({ projectId });
  db = getFirestore(admin);
  for (const uid of [
    "p210-admin",
    "p210-parent1",
    "p210-parent2",
    "p210-viewer",
    "p210-self",
    "p210-outsider",
    "p210-coach",
    "p210-support",
  ]) {
    const app = initializeApp({ projectId, apiKey: "demo-key" }, uid);
    apps[uid] = app;
    connectAuthEmulator(getAuth(app), "http://127.0.0.1:9099", {
      disableWarnings: true,
    });
    connectFunctionsEmulator(getFunctions(app), "127.0.0.1", 5001);
    connectFirestoreEmulator(clientDb(app), "127.0.0.1", 8080);
    await adminAuth(admin).createUser({
      uid,
      email: `${uid}@example.test`,
      password: "SyntheticPassword123!",
    });
    await db
      .doc(`users/${uid}`)
      .set({ uid, appRole: uid === "p210-support" ? "superAdmin" : "user" });
    await signInWithEmailAndPassword(
      getAuth(app),
      `${uid}@example.test`,
      "SyntheticPassword123!",
    );
  }
  await db.doc("organizations/p210-org").set({
    ...meta,
    name: "Synthetic league",
    features: { organizationV2: true, households: true, attendance: true },
  });
  for (const [kind, name] of [
    ["programs", scope.programId],
    ["seasons", scope.seasonId],
    ["divisions", scope.divisionId],
  ])
    await db
      .doc(`organizations/p210-org/${kind}/${name}`)
      .set({ ...meta, ...scope, name });
  await db
    .doc("organizations/p210-org/members/p210-admin")
    .set({ ...meta, orgId: scope.orgId, roles: ["orgAdmin"], programIds: [] });
  for (const teamId of ["p210-a", "p210-b"])
    await db.doc(`teams/${teamId}`).set({ ...meta, ...scope, name: teamId });
  await db.doc("teamMembers/p210-a_p210-coach").set({
    ...meta,
    orgId: scope.orgId,
    teamId: "p210-a",
    userId: "p210-coach",
    roles: ["coach"],
  });
  for (const p of ["p210-child-a", "p210-child-b"]) {
    await db.doc(part(p)).set({
      ...meta,
      orgId: scope.orgId,
      displayName: p,
      kind: "adult",
      linkedUserId: p.endsWith("-a") ? "p210-self" : null,
    });
    for (const teamId of ["p210-a", "p210-b"])
      await db
        .doc(`teams/${teamId}/roster/${p}`)
        .set({ ...meta, orgId: scope.orgId, participantId: p });
    for (const uid of ["p210-parent1", "p210-parent2", "p210-viewer"])
      await db.doc(grant(p, uid)).set({
        ...meta,
        orgId: scope.orgId,
        participantId: p,
        userId: uid,
        permissions: {
          viewSchedule: true,
          viewProfile: true,
          editProfile: false,
          respond: uid !== "p210-viewer",
        },
      });
  }
});
after(async () => {
  await Promise.all(Object.values(apps).map(deleteApp));
  await deleteAdmin(admin);
});

const record = (e, extra = {}, uid = "p210-coach") =>
  call(
    uid,
    "recordEventAttendance",
    req({
      eventId: e.id,
      teamId: "p210-a",
      participantId: "p210-child-a",
      expectedRevision: 0,
      eventRevision: 1,
      scheduleVersion: 1,
      status: "present",
      ...extra,
    }),
  );
const complete = (e) =>
  call(
    "p210-admin",
    "mutateEventSchedule",
    req({
      eventId: e.id,
      expectedRevision: 1,
      action: "complete",
      reason: "Game finished",
    }),
  );
test("manual attendance works with no device, no RSVP and declined RSVP; revisions and correction audit are immutable", async () => {
  const e = await create();
  assert.ok(
    (await read(e)).items.every(
      (r) => r.status === "unknown" && r.intended === "unanswered",
    ),
  );
  await db
    .doc(`events/${e.id}/availability/p210-child-a`)
    .set({ status: "no", scheduleVersion: 1 });
  await record(e);
  let row = (await read(e)).items[0];
  assert.equal(row.intended, "no");
  assert.equal(row.status, "present");
  assert.equal(row.recordedBy, "p210-coach");
  await assert.rejects(record(e, { expectedRevision: 1, status: "late" }), {
    code: "functions/invalid-argument",
  });
  const payload = req({
    eventId: e.id,
    teamId: "p210-a",
    participantId: "p210-child-a",
    expectedRevision: 1,
    eventRevision: 1,
    scheduleVersion: 1,
    status: "late",
    reason: "Arrived after warmup",
  });
  const results = await Promise.allSettled([
    call("p210-coach", "recordEventAttendance", payload),
    record(e, {
      expectedRevision: 1,
      status: "absent",
      reason: "Other observation",
    }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const successful = results[0].status === "fulfilled";
  if (successful)
    assert.deepEqual(
      await call("p210-coach", "recordEventAttendance", payload),
      results[0].value,
    );
  const h = await call("p210-coach", "getAttendanceHistory", {
    eventId: e.id,
    teamId: "p210-a",
    participantId: "p210-child-a",
    pageSize: 1,
  });
  assert.equal(h.items[0].status, "present");
  assert.ok(h.nextCursor);
  const next = await call("p210-coach", "getAttendanceHistory", {
    eventId: e.id,
    teamId: "p210-a",
    participantId: "p210-child-a",
    cursor: h.nextCursor,
    pageSize: 1,
  });
  assert.equal(next.items[0].revision, 2);
  assert.ok(next.items[0].reason);
});
test("completion freezes unique eligibility, preserves removed members and never infers absence", async () => {
  const e = await create();
  await db
    .doc("teams/p210-a/roster/p210-child-b")
    .update({ status: "removed", removedAt: Timestamp.now() });
  await db
    .doc("teams/p210-b/roster/p210-child-b")
    .update({ status: "removed", removedAt: Timestamp.now() });
  await record(e);
  await complete(e);
  let loaded = await read(e);
  const summary = (await db.doc(`events/${e.id}`).get()).data().rosterSnapshot;
  assert.equal(summary.participantCount, 2);
  assert.equal(summary.eligibleCount, 1);
  assert.equal(loaded.snapshot.eligibleCount, undefined);
  assert.equal(loaded.items[1].status, "unknown");
  assert.equal(loaded.items[1].eligible, false);
  assert.equal(
    (await db.collection(`events/${e.id}/attendance`).get()).size,
    1,
  );
  const snapshots = await db.collection(`events/${e.id}/rosterSnapshots`).get();
  assert.equal(snapshots.size, 2);
  assert.equal(snapshots.docs[0].data().teamIds.length, 2);
  await db
    .doc("teams/p210-a/roster/p210-child-a")
    .update({ status: "removed" });
  await db.doc(part("p210-child-a")).update({ status: "archived" });
  loaded = await read(e);
  assert.equal(loaded.items[0].eligible, true);
  await assert.rejects(
    record(e, { eventRevision: 2, expectedRevision: 1, status: "excused" }),
    { code: "functions/invalid-argument" },
  );
  await record(e, {
    eventRevision: 2,
    expectedRevision: 1,
    status: "excused",
    reason: "Coach reviewed attendance",
  });
  assert.equal((await read(e)).items[0].status, "excused");
  assert.equal(
    (await db.doc(`events/${e.id}/rosterSnapshots/p210-child-a`).get()).data()
      .capturedRevision,
    2,
  );
  // Restore canonical source for subsequent independent event fixtures.
  for (const team of ["p210-a", "p210-b"])
    for (const p of ["p210-child-a", "p210-child-b"])
      await db
        .doc(`teams/${team}/roster/${p}`)
        .update({ status: "active", removedAt: null });
  await db.doc(part("p210-child-a")).update({ status: "active" });
});
test("cancelled, postponed, uncommitted, foreign and closed-resource events deny attendance", async () => {
  for (const status of ["cancelled", "postponed"]) {
    const e = await create();
    await db.doc(`events/${e.id}`).update({ status });
    await assert.rejects(record(e), { code: "functions/failed-precondition" });
    assert.ok(
      (await read(e)).items.every(
        (r) => !r.canRecord && r.status === "unknown",
      ),
    );
  }
  const e = await create();
  await db
    .doc(`events/${e.id}`)
    .update({ publicationOperationId: "uncommitted" });
  await deny(read(e));
  await deny(record(e));
  await db
    .doc(`events/${e.id}`)
    .update({
      publicationOperationId: null,
      facilityId: "fieldsite",
      resourceId: "field",
    });
  await db
    .doc("organizations/p210-org/closures/closed")
    .set({
      ...meta,
      orgId: scope.orgId,
      facilityId: "fieldsite",
      resourceIds: ["field"],
      startsAt: "2026-12-20T22:00:00.000Z",
      endsAt: "2026-12-21T01:00:00.000Z",
      status: "applied",
    });
  await assert.rejects(record(e), { code: "functions/failed-precondition" });
  assert.ok((await read(e)).items.every((r) => !r.canRecord));
  await db.doc("teams/p210-b").update({ orgId: "foreign" });
  await deny(read(e));
  await db.doc("teams/p210-b").update({ orgId: scope.orgId });
});
test("live team authority, household privacy, removed roster and deleting-account replay fail closed", async () => {
  const e = await create();
  for (const uid of [
    "p210-parent1",
    "p210-self",
    "p210-outsider",
    "p210-support",
  ]) {
    await deny(read(e, uid));
    await deny(record(e, {}, uid));
  }
  await deny(read(e, "p210-coach", { teamId: "p210-b" }));
  const payload = req({
    eventId: e.id,
    teamId: "p210-a",
    participantId: "p210-child-a",
    expectedRevision: 0,
    eventRevision: 1,
    scheduleVersion: 1,
    status: "present",
  });
  await call("p210-coach", "recordEventAttendance", payload);
  await db.doc("teamMembers/p210-a_p210-coach").update({ status: "revoked" });
  await deny(call("p210-coach", "recordEventAttendance", payload));
  await deny(read(e));
  await db.doc("teamMembers/p210-a_p210-coach").update({ status: "active" });
  await db.doc("accountDeletionJobs/p210-coach").set({ status: "pending" });
  await deny(call("p210-coach", "recordEventAttendance", payload));
  await db.doc("accountDeletionJobs/p210-coach").delete();
  await db
    .doc("teams/p210-a/roster/p210-child-b")
    .update({ status: "removed" });
  await deny(record(e, { participantId: "p210-child-b" }));
  await db.doc("teams/p210-a/roster/p210-child-b").update({ status: "active" });
  await assert.rejects(
    setDoc(
      doc(
        clientDb(apps["p210-coach"]),
        `events/${e.id}/attendance/p210-child-a`,
      ),
      { status: "absent" },
    ),
    { code: "permission-denied" },
  );
  await assert.rejects(
    getDoc(
      doc(
        clientDb(apps["p210-parent1"]),
        `events/${e.id}/rosterSnapshots/p210-child-a`,
      ),
    ),
    { code: "permission-denied" },
  );
});
test("rescheduling retains prior attendance as history; current schedule remains unknown; stale writes and rollout disabled", async () => {
  const e = await create();
  await record(e);
  await call(
    "p210-admin",
    "mutateEventSchedule",
    req({
      eventId: e.id,
      expectedRevision: 1,
      action: "reschedule",
      reason: "New date",
      patch: {
        startsAt: "2026-12-22T23:00:00.000Z",
        endsAt: "2026-12-23T00:00:00.000Z",
        timeZone: "America/Chicago",
      },
    }),
  );
  const row = (await read(e)).items[0];
  assert.equal(row.status, "unknown");
  assert.equal(row.previousStatus, "present");
  await assert.rejects(record(e, { expectedRevision: 1, reason: "Recheck" }), {
    code: "functions/aborted",
  });
  await record(e, {
    eventRevision: 2,
    expectedRevision: 1,
    scheduleVersion: 2,
    reason: "Confirmed at new time",
  });
  assert.equal((await read(e)).items[0].status, "present");
  await db
    .doc("organizations/p210-org")
    .update({ "features.attendance": false });
  assert.ok((await read(e)).items.every((r) => !r.canRecord));
  await assert.rejects(
    record(e, {
      eventRevision: 2,
      expectedRevision: 2,
      scheduleVersion: 2,
      reason: "Review",
    }),
    { code: "functions/failed-precondition" },
  );
  await db
    .doc("organizations/p210-org")
    .update({ "features.attendance": true });
});
test("paged reporting reads include unknowns and stable completion denominator, without extra roster or attendance rows", async () => {
  const e = await create();
  const first = await read(e, "p210-coach", { pageSize: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const second = await read(e, "p210-coach", {
    pageSize: 1,
    cursor: first.nextCursor,
  });
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0].participantId, second.items[0].participantId);
  await complete(e);
  assert.equal(
    (await db.collection(`events/${e.id}/attendance`).get()).size,
    0,
  );
  const frozen = await read(e);
  assert.equal(
    (await db.doc(`events/${e.id}`).get()).data().rosterSnapshot.eligibleCount,
    2,
  );
  assert.ok(frozen.items.every((r) => r.status === "unknown"));
});
test("oversized completion fails atomically instead of truncating denominator", async () => {
  const e = await create();
  const batch = db.batch();
  for (let i = 0; i < 201; i++)
    batch.set(db.doc(`teams/p210-a/roster/p210-large-${i}`), {
      ...meta,
      orgId: scope.orgId,
      participantId: `p210-large-${i}`,
    });
  await batch.commit();
  await assert.rejects(complete(e), { code: "functions/resource-exhausted" });
  assert.equal(
    (await db.doc(`events/${e.id}`).get()).data().status,
    "scheduled",
  );
  assert.equal(
    (await db.collection(`events/${e.id}/rosterSnapshots`).get()).size,
    0,
  );
});
test("deletion removes account access and receipts while retaining attendance and immutable audit", async () => {
  const e = await create();
  await record(e);
  await call("p210-coach", "deleteAccount", {});
  const row = (
    await db.doc(`events/${e.id}/attendance/p210-child-a`).get()
  ).data();
  assert.equal(row.status, "present");
  assert.equal(row.recordedBy, "p210-coach");
  assert.equal(
    (
      await db
        .collection(`events/${e.id}/attendance/p210-child-a/history`)
        .get()
    ).size,
    1,
  );
  await deny(read(e));
});
