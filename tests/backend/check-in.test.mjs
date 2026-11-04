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
const req = (payload) => ({ requestId: `p211-${++seq}`, ...payload });
const deny = (promise) =>
  assert.rejects(promise, { code: "functions/permission-denied" });
const scope = {
  orgId: "p211-org",
  programId: "p211-program",
  seasonId: "p211-season",
  divisionId: "p211-division",
};
const meta = {
  schemaVersion: 2,
  revision: 1,
  status: "active",
  createdAt: Timestamp.now(),
  updatedAt: Timestamp.now(),
};
const part = (p) => `organizations/p211-org/participants/${p}`;
const grant = (p, u) => `${part(p)}/guardians/${u}`;
const read = (e, uid = "p211-coach", extra = {}) =>
  call(uid, "getEventAttendance", {
    eventId: e.id,
    teamId: "p211-a",
    ...extra,
  });
async function create(extra = {}) {
  return call(
    "p211-admin",
    "createEvent",
    req({
      teamId: "p211-a",
      event: {
        title: "Synthetic sibling match",
        type: "match",
        teamIds: ["p211-a", "p211-b"],
        startsAt: new Date(Date.now() - 60000).toISOString(),
        endsAt: new Date(Date.now() + 3600000).toISOString(),
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
    "p211-admin",
    "p211-parent1",
    "p211-parent2",
    "p211-viewer",
    "p211-self",
    "p211-outsider",
    "p211-coach",
    "p211-support",
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
      .set({ uid, appRole: uid === "p211-support" ? "superAdmin" : "user" });
    await signInWithEmailAndPassword(
      getAuth(app),
      `${uid}@example.test`,
      "SyntheticPassword123!",
    );
  }
  await db.doc("organizations/p211-org").set({
    ...meta,
    name: "Synthetic league",
    features: {
      organizationV2: true,
      households: true,
      attendance: true,
      locationAssistance: true,
    },
  });
  for (const [kind, name] of [
    ["programs", scope.programId],
    ["seasons", scope.seasonId],
    ["divisions", scope.divisionId],
  ])
    await db
      .doc(`organizations/p211-org/${kind}/${name}`)
      .set({ ...meta, ...scope, name });
  await db
    .doc("organizations/p211-org/members/p211-admin")
    .set({ ...meta, orgId: scope.orgId, roles: ["orgAdmin"], programIds: [] });
  for (const teamId of ["p211-a", "p211-b"])
    await db.doc(`teams/${teamId}`).set({ ...meta, ...scope, name: teamId });
  await db.doc("teamMembers/p211-a_p211-coach").set({
    ...meta,
    orgId: scope.orgId,
    teamId: "p211-a",
    userId: "p211-coach",
    roles: ["coach"],
  });
  for (const p of ["p211-child-a", "p211-child-b"]) {
    await db.doc(part(p)).set({
      ...meta,
      orgId: scope.orgId,
      displayName: p,
      kind: "adult",
      linkedUserId: p.endsWith("-a") ? "p211-self" : null,
    });
    for (const teamId of ["p211-a", "p211-b"])
      await db
        .doc(`teams/${teamId}/roster/${p}`)
        .set({ ...meta, orgId: scope.orgId, participantId: p });
    for (const uid of ["p211-parent1", "p211-parent2", "p211-viewer"])
      await db.doc(grant(p, uid)).set({
        ...meta,
        orgId: scope.orgId,
        participantId: p,
        userId: uid,
        permissions: {
          viewSchedule: true,
          viewProfile: true,
          editProfile: false,
          respond: uid !== "p211-viewer",
        },
      });
  }
});
after(async () => {
  await Promise.all(Object.values(apps).map(deleteApp));
  await deleteAdmin(admin);
});

const info = (e, uid = "p211-parent1", extra = {}) =>
  call(uid, "getParticipantCheckIn", {
    eventId: e.id,
    participantId: "p211-child-a",
    ...extra,
  });
const sample = () => ({
  latitude: 41,
  longitude: -87,
  accuracy: 20,
  timestamp: Date.now() - 1000,
});
const check = (e, extra = {}, uid = "p211-parent1") =>
  call(
    uid,
    "checkInParticipant",
    req({
      eventId: e.id,
      participantId: "p211-child-a",
      eventRevision: 1,
      scheduleVersion: 1,
      expectedRevision: 0,
      method: "simple",
      ...extra,
    }),
  );
const policy = {
  beforeMinutes: 40,
  afterMinutes: 120,
  radiusMeters: 500,
  locationEnabled: true,
};
async function located() {
  const e = await create();
  await db
    .doc(`events/${e.id}`)
    .update({ resourceDetails: { latitude: 41, longitude: -87 } });
  return e;
}
test("guardian and self assertions share attendance/history, need no RSVP and store no sample", async () => {
  const e = await located();
  assert.equal((await info(e)).status, "unknown");
  await db
    .doc(`events/${e.id}/availability/p211-child-a`)
    .set({ status: "no", scheduleVersion: 1 });
  const payload = req({
    eventId: e.id,
    participantId: "p211-child-a",
    eventRevision: 1,
    scheduleVersion: 1,
    expectedRevision: 0,
    method: "location",
    sample: sample(),
  });
  const result = await call("p211-parent1", "checkInParticipant", payload);
  assert.deepEqual(
    await call("p211-parent1", "checkInParticipant", payload),
    result,
  );
  const row = (
    await db.doc(`events/${e.id}/attendance/p211-child-a`).get()
  ).data();
  assert.equal(row.status, "present");
  assert.equal(row.source, "guardian");
  assert.equal(row.method, "location");
  const history = await db
    .collection(`events/${e.id}/attendance/p211-child-a/history`)
    .get();
  assert.equal(history.size, 1);
  for (const saved of [
    row,
    history.docs[0].data(),
    ...(
      await db
        .collection("commandRequests")
        .where("operation", "==", "checkInParticipant")
        .get()
    ).docs.map((d) => d.data()),
  ])
    for (const raw of [
      "latitude",
      "longitude",
      "accuracy",
      "timestamp",
      '"sample"',
    ])
      assert.ok(!JSON.stringify(saved).includes(raw));
  assert.match((await info(e)).closedReason, /already recorded/);
  await assert.rejects(check(e, { expectedRevision: 1 }), {
    code: "functions/failed-precondition",
  });
  const self = await create();
  await check(self, {}, "p211-self");
  assert.equal((await info(self)).source, "self");
  const other = await info(self, "p211-parent1", {
    participantId: "p211-child-b",
  });
  assert.equal(other.status, "unknown");
  // Staff correction remains authoritative and requires a reason.
  await call(
    "p211-coach",
    "recordEventAttendance",
    req({
      eventId: e.id,
      teamId: "p211-a",
      participantId: "p211-child-a",
      eventRevision: 1,
      scheduleVersion: 1,
      expectedRevision: 1,
      status: "absent",
      reason: "Coach observed participant was away",
    }),
  );
  assert.equal((await info(e)).status, "absent");
  await assert.rejects(check(e, { expectedRevision: 2 }), {
    code: "functions/failed-precondition",
  });
});
test("invalid, stale, future, poor, distant and missing-venue samples fail with useful fallback", async () => {
  const e = await located();
  for (const [patch, code, message] of [
    [{ latitude: 91 }, "invalid-argument", /Invalid location/],
    [{ longitude: -181 }, "invalid-argument", /Invalid location/],
    [{ accuracy: 0 }, "invalid-argument", /Invalid location/],
    [{ latitude: "41" }, "invalid-argument", /Invalid location/],
    [{ timestamp: Date.now() - 70000 }, "failed-precondition", /stale/],
    [{ timestamp: Date.now() + 60000 }, "failed-precondition", /stale/],
    [{ accuracy: 101 }, "failed-precondition", /accuracy is poor/],
    [{ latitude: 42 }, "failed-precondition", /Outside/],
  ])
    await assert.rejects(
      check(e, { method: "location", sample: { ...sample(), ...patch } }),
      { code: `functions/${code}`, message },
    );
  const missing = await create();
  await assert.rejects(
    check(missing, { method: "location", sample: sample() }),
    { code: "functions/failed-precondition", message: /Venue coordinates/ },
  );
  assert.equal(
    (await db.collection(`events/${e.id}/attendance`).get()).size,
    0,
  );
  await check(missing);
  assert.equal((await info(missing)).status, "present");
  await assert.rejects(check(e, { method: "simple", sample: sample() }), {
    code: "functions/invalid-argument",
  });
});
test("live household, roster and publication authority is required on discovery and receipt replay", async () => {
  const e = await create();
  for (const uid of [
    "p211-viewer",
    "p211-outsider",
    "p211-support",
    "p211-coach",
  ]) {
    await deny(info(e, uid));
    await deny(check(e, {}, uid));
  }
  const payload = req({
    eventId: e.id,
    participantId: "p211-child-a",
    eventRevision: 1,
    scheduleVersion: 1,
    expectedRevision: 0,
    method: "simple",
  });
  await call("p211-parent1", "checkInParticipant", payload);
  const replay = () => call("p211-parent1", "checkInParticipant", payload);
  await db
    .doc(grant("p211-child-a", "p211-parent1"))
    .update({ status: "revoked" });
  await deny(info(e));
  await deny(replay());
  await db
    .doc(grant("p211-child-a", "p211-parent1"))
    .update({ status: "active", "permissions.respond": false });
  await deny(replay());
  await db
    .doc(grant("p211-child-a", "p211-parent1"))
    .update({ "permissions.respond": true });
  for (const t of ["p211-a", "p211-b"])
    await db
      .doc(`teams/${t}/roster/p211-child-a`)
      .update({ status: "removed" });
  await deny(info(e));
  await deny(replay());
  for (const t of ["p211-a", "p211-b"])
    await db.doc(`teams/${t}/roster/p211-child-a`).update({ status: "active" });
  await db.doc(`events/${e.id}`).update({ publicationOperationId: "staging" });
  await deny(info(e));
  await deny(replay());
  await db.doc(`events/${e.id}`).update({ publicationOperationId: null });
  await db.doc("teams/p211-b").update({ orgId: "foreign" });
  await deny(info(e));
  await deny(replay());
  await db.doc("teams/p211-b").update({ orgId: scope.orgId });
  await db.doc("accountDeletionJobs/p211-parent1").set({ status: "pending" });
  await deny(info(e));
  await deny(replay());
  await db.doc("accountDeletionJobs/p211-parent1").delete();
  // Direct client writes and reads of another participant remain forbidden.
  await assert.rejects(
    setDoc(
      doc(
        clientDb(apps["p211-parent1"]),
        `events/${e.id}/attendance/p211-child-a`,
      ),
      { status: "present" },
    ),
    { code: "permission-denied" },
  );
  await assert.rejects(
    getDoc(
      doc(
        clientDb(apps["p211-parent1"]),
        `events/${e.id}/attendance/p211-child-b`,
      ),
    ),
    { code: "permission-denied" },
  );
});
test("lifecycle, time window, resource closure, archived hierarchy and independent rollout gates close new assertions", async () => {
  for (const status of ["cancelled", "postponed", "completed"]) {
    const e = await create();
    await db.doc(`events/${e.id}`).update({ status });
    assert.match((await info(e)).closedReason, /closed/);
    await assert.rejects(check(e), { code: "functions/failed-precondition" });
  }
  for (const offset of [-3 * 3600000, 41 * 60000]) {
    const e = await create({
      startsAt: new Date(Date.now() + offset).toISOString(),
      endsAt: new Date(Date.now() + offset + 3600000).toISOString(),
    });
    assert.match((await info(e)).closedReason, /Outside/);
    await assert.rejects(check(e), { code: "functions/failed-precondition" });
  }
  const e = await located();
  await db
    .doc("organizations/p211-org")
    .update({ "features.locationAssistance": false });
  assert.equal((await info(e)).locationEnabled, false);
  await assert.rejects(check(e, { method: "location", sample: sample() }), {
    code: "functions/failed-precondition",
  });
  await check(e);
  await db
    .doc("organizations/p211-org")
    .update({ "features.locationAssistance": true });
  const disabled = await create();
  await db
    .doc("organizations/p211-org")
    .update({ "features.attendance": false });
  assert.match((await info(disabled)).closedReason, /not enabled/);
  await assert.rejects(check(disabled), {
    code: "functions/failed-precondition",
  });
  await db
    .doc("organizations/p211-org")
    .update({ "features.attendance": true });
  await db
    .doc(`organizations/p211-org/seasons/${scope.seasonId}`)
    .update({ status: "archived" });
  assert.match((await info(disabled)).closedReason, /closed/);
  await assert.rejects(check(disabled), {
    code: "functions/failed-precondition",
  });
  await db
    .doc(`organizations/p211-org/seasons/${scope.seasonId}`)
    .update({ status: "active" });
  await db
    .doc(`events/${disabled.id}`)
    .update({ facilityId: "site", resourceId: "field" });
  await db
    .doc("organizations/p211-org/closures/closed")
    .set({
      ...meta,
      orgId: scope.orgId,
      facilityId: "site",
      resourceIds: ["field"],
      startsAt: new Date(Date.now() - 3600000).toISOString(),
      endsAt: new Date(Date.now() + 3600000).toISOString(),
      status: "applied",
    });
  assert.match((await info(disabled)).closedReason, /closed/);
  await assert.rejects(check(disabled), {
    code: "functions/failed-precondition",
  });
});
test("staff configurable bounded policy increments event revision, preserves audit and rejects stale or private callers", async () => {
  const e = await create();
  const set = (uid, value, rev = 1) =>
    call(
      uid,
      "setEventCheckInPolicy",
      req({ eventId: e.id, expectedRevision: rev, policy: value }),
    );
  await deny(set("p211-parent1", policy));
  await deny(set("p211-coach", policy)); // coach has only one of both event teams
  for (const patch of [
    { beforeMinutes: 121 },
    { afterMinutes: -1 },
    { radiusMeters: 1001 },
    { radiusMeters: 49 },
    { locationEnabled: "yes" },
  ])
    await assert.rejects(set("p211-admin", { ...policy, ...patch }), {
      code: "functions/invalid-argument",
    });
  await set("p211-admin", {
    ...policy,
    radiusMeters: 250,
    locationEnabled: false,
  });
  const loaded = await info(e);
  assert.equal(loaded.eventRevision, 2);
  assert.equal(loaded.policy.radiusMeters, 250);
  assert.equal(loaded.locationEnabled, false);
  assert.equal(
    (await db.collection(`events/${e.id}/checkInPolicyHistory`).get()).size,
    1,
  );
  await assert.rejects(check(e), { code: "functions/aborted" });
  await check(e, { eventRevision: 2 });
});
test("concurrent guardians cannot overwrite attendance and changed schedules require a fresh assertion", async () => {
  const e = await create();
  const results = await Promise.allSettled([
    check(e),
    check(e, {}, "p211-parent2"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    (
      await db
        .collection(`events/${e.id}/attendance/p211-child-a/history`)
        .get()
    ).size,
    1,
  );
  await db.doc(`events/${e.id}`).update({ revision: 2, scheduleVersion: 2 });
  assert.equal((await info(e)).status, "unknown");
  await assert.rejects(check(e, { expectedRevision: 1 }), {
    code: "functions/aborted",
  });
  await check(e, { eventRevision: 2, scheduleVersion: 2, expectedRevision: 1 });
  const row = (
    await db.doc(`events/${e.id}/attendance/p211-child-a`).get()
  ).data();
  assert.equal(row.previousScheduleVersion, 1);
  assert.ok(row.correctionReason);
});
test("distance/sample boundaries include exact radius, age and accuracy and reject nonfinite data", () => {
  const { locationOutcome } = require("./lib/operations/checkInPolicy.js");
  const now = 1000000,
    venue = { latitude: 0, longitude: 0 };
  const value = {
    latitude: 0,
    longitude: 0,
    accuracy: 100,
    timestamp: now - 60000,
  };
  assert.equal(locationOutcome(value, venue, now, 500), null);
  assert.match(
    locationOutcome({ ...value, timestamp: now - 60001 }, venue, now, 500),
    /stale/,
  );
  assert.match(
    locationOutcome({ ...value, accuracy: Infinity }, venue, now, 500),
    /Invalid/,
  );
  assert.match(
    locationOutcome(value, { latitude: NaN, longitude: 0 }, now, 500),
    /Venue/,
  );
  const latitude = ((499.99 / 6371000) * 180) / Math.PI;
  assert.equal(locationOutcome({ ...value, latitude }, venue, now, 500), null);
  assert.match(
    locationOutcome(
      { ...value, latitude: latitude + 0.000001 },
      venue,
      now,
      500,
    ),
    /Outside/,
  );
});
