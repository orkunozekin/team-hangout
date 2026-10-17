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
const req = (payload) => ({ requestId: `p209-${++seq}`, ...payload });
const deny = (promise) =>
  assert.rejects(promise, { code: "functions/permission-denied" });
const scope = {
  orgId: "p209-org",
  programId: "p209-program",
  seasonId: "p209-season",
  divisionId: "p209-division",
};
const meta = {
  schemaVersion: 2,
  revision: 1,
  status: "active",
  createdAt: Timestamp.now(),
  updatedAt: Timestamp.now(),
};
const part = (p) => `organizations/p209-org/participants/${p}`;
const grant = (p, u) => `${part(p)}/guardians/${u}`;
const read = (e, uid = "p209-parent1") =>
  call(uid, "getEventAvailability", { eventId: e.id });
const response = (e, p = "p209-child-a", extra = {}) =>
  req({
    eventId: e.id,
    participantId: p,
    expectedRevision: 0,
    scheduleVersion: 1,
    status: "yes",
    ...extra,
  });
async function create(extra = {}) {
  return call(
    "p209-admin",
    "createEvent",
    req({
      teamId: "p209-a",
      event: {
        title: "Synthetic sibling match",
        type: "match",
        teamIds: ["p209-a", "p209-b"],
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
    "p209-admin",
    "p209-parent1",
    "p209-parent2",
    "p209-viewer",
    "p209-self",
    "p209-outsider",
    "p209-coach",
    "p209-support",
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
      .set({ uid, appRole: uid === "p209-support" ? "superAdmin" : "user" });
    await signInWithEmailAndPassword(
      getAuth(app),
      `${uid}@example.test`,
      "SyntheticPassword123!",
    );
  }
  await db
    .doc("organizations/p209-org")
    .set({
      ...meta,
      name: "Synthetic league",
      features: { organizationV2: true, households: true },
    });
  for (const [kind, name] of [
    ["programs", scope.programId],
    ["seasons", scope.seasonId],
    ["divisions", scope.divisionId],
  ])
    await db
      .doc(`organizations/p209-org/${kind}/${name}`)
      .set({ ...meta, ...scope, name });
  await db
    .doc("organizations/p209-org/members/p209-admin")
    .set({ ...meta, orgId: scope.orgId, roles: ["orgAdmin"], programIds: [] });
  for (const teamId of ["p209-a", "p209-b"])
    await db.doc(`teams/${teamId}`).set({ ...meta, ...scope, name: teamId });
  await db
    .doc("teamMembers/p209-a_p209-coach")
    .set({
      ...meta,
      orgId: scope.orgId,
      teamId: "p209-a",
      userId: "p209-coach",
      roles: ["coach"],
    });
  for (const p of ["p209-child-a", "p209-child-b"]) {
    await db
      .doc(part(p))
      .set({
        ...meta,
        orgId: scope.orgId,
        displayName: p,
        kind: "adult",
        linkedUserId: p.endsWith("-a") ? "p209-self" : null,
      });
    for (const teamId of ["p209-a", "p209-b"])
      await db
        .doc(`teams/${teamId}/roster/${p}`)
        .set({ ...meta, orgId: scope.orgId, participantId: p });
    for (const uid of ["p209-parent1", "p209-parent2", "p209-viewer"])
      await db
        .doc(grant(p, uid))
        .set({
          ...meta,
          orgId: scope.orgId,
          participantId: p,
          userId: uid,
          permissions: {
            viewSchedule: true,
            viewProfile: true,
            editProfile: false,
            respond: uid !== "p209-viewer",
          },
        });
  }
});
after(async () => {
  await Promise.all(Object.values(apps).map(deleteApp));
  await deleteAdmin(admin);
});
test("participant responses distinguish unanswered and maybe, share guardian edits and keep private roster boundaries", async () => {
  const e = await create();
  let loaded = await read(e);
  assert.equal(loaded.items.length, 2);
  assert.ok(loaded.items.every((i) => i.status === "unanswered"));
  assert.deepEqual(loaded.summaries, []);
  await call(
    "p209-parent1",
    "respondToEvent",
    response(e, "p209-child-b", {
      status: "maybe",
      lateNote: "Arriving after school",
    }),
  );
  loaded = await read(e, "p209-parent2");
  assert.equal(loaded.items[1].status, "maybe");
  assert.equal(loaded.items[1].actor, "Another guardian");
  assert.ok(!JSON.stringify(loaded).includes("p209-parent1"));
  const coach = await read(e, "p209-coach");
  assert.deepEqual(coach.items, []);
  assert.equal(coach.summaries.length, 1);
  assert.deepEqual(coach.summaries[0].counts, {
    yes: 0,
    no: 0,
    maybe: 1,
    unanswered: 1,
    needsReconfirmation: 0,
  });
  const staff = await read(e, "p209-admin");
  assert.equal(staff.summaries.length, 2); // Each participant counted once within each enrolled team.
  for (const uid of ["p209-outsider", "p209-support"]) {
    await deny(read(e, uid));
    await deny(call(uid, "respondToEvent", response(e)));
  }
  await deny(call("p209-coach", "respondToEvent", response(e)));
  await deny(call("p209-viewer", "respondToEvent", response(e)));
  assert.ok((await read(e, "p209-viewer")).items.every((i) => !i.canRespond));
  await call("p209-self", "respondToEvent", response(e));
  assert.equal((await read(e, "p209-self")).items[0].actor, "You");
  await assert.rejects(
    getDoc(
      doc(
        clientDb(apps["p209-parent1"]),
        "events",
        e.id,
        "availability",
        "p209-child-a",
      ),
    ),
    { code: "permission-denied" },
  );
  await assert.rejects(
    setDoc(
      doc(
        clientDb(apps["p209-parent1"]),
        "events",
        e.id,
        "availability",
        "p209-child-a",
      ),
      { status: "yes" },
    ),
    { code: "permission-denied" },
  );
});
test("concurrent guardians commit one deterministic revision and must review before overwriting", async () => {
  const e = await create();
  const requests = ["p209-parent1", "p209-parent2"].map((u, i) =>
    call(
      u,
      "respondToEvent",
      response(e, "p209-child-a", { status: i ? "no" : "yes" }),
    ),
  );
  const results = await Promise.allSettled(requests);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const failed = results.find((r) => r.status === "rejected");
  assert.equal(failed.reason.details.domainCode, "STALE_REVISION");
  const rows = await db.collection(`events/${e.id}/availability`).get();
  assert.equal(rows.size, 1);
  assert.equal(rows.docs[0].id, "p209-child-a");
  assert.equal(
    (
      await db
        .collection(`events/${e.id}/availability/p209-child-a/history`)
        .get()
    ).size,
    1,
  );
  const payload = response(e, "p209-child-a", {
    expectedRevision: 1,
    status: "maybe",
    lateNote: "Ten minutes late",
  });
  const [a, b] = await Promise.all([
    call("p209-parent2", "respondToEvent", payload),
    call("p209-parent2", "respondToEvent", payload),
  ]);
  assert.deepEqual(a, b);
  assert.equal(a.revision, 2);
  await assert.rejects(
    call("p209-parent2", "respondToEvent", { ...payload, status: "yes" }),
    (e) => e.details.domainCode === "REQUEST_ID_REUSED",
  );
});
test("reschedule retains identity and immutable historical responses, excluding them until explicit reconfirmation", async () => {
  const e = await create();
  await call("p209-parent1", "respondToEvent", response(e));
  await call(
    "p209-admin",
    "setEventRsvpDeadline",
    req({
      eventId: e.id,
      expectedRevision: 1,
      deadline: "2026-12-19T23:00:00.000Z",
    }),
  );
  await call(
    "p209-admin",
    "mutateEventSchedule",
    req({
      eventId: e.id,
      expectedRevision: 2,
      action: "reschedule",
      reason: "Synthetic makeup",
      patch: {
        startsAt: "2026-12-22T23:00:00.000Z",
        endsAt: "2026-12-23T00:00:00.000Z",
        timeZone: "America/Chicago",
      },
    }),
  );
  const loaded = await read(e);
  assert.equal(loaded.items[0].status, "needsReconfirmation");
  assert.equal(loaded.items[0].previousStatus, "yes");
  assert.equal(loaded.deadline, "2026-12-22T23:00:00.000Z");
  const staff = await read(e, "p209-admin");
  assert.equal(staff.summaries[0].counts.yes, 0);
  assert.equal(staff.summaries[0].counts.needsReconfirmation, 1);
  await assert.rejects(
    call(
      "p209-parent1",
      "respondToEvent",
      response(e, "p209-child-a", { expectedRevision: 1 }),
    ),
    (e) => e.details.domainCode === "SCHEDULE_CHANGED",
  );
  await call(
    "p209-parent2",
    "respondToEvent",
    response(e, "p209-child-a", {
      expectedRevision: 1,
      scheduleVersion: 2,
      status: "no",
    }),
  );
  assert.equal((await read(e)).items[0].status, "no");
  const history = await db
    .collection(`events/${e.id}/availability/p209-child-a/history`)
    .orderBy("revision")
    .get();
  assert.deepEqual(
    history.docs.map((d) => [d.data().status, d.data().scheduleVersion]),
    [
      ["yes", 1],
      ["no", 2],
    ],
  );
  assert.equal(
    (await db.collection(`events/${e.id}/attendance`).get()).size,
    0,
  );
});
test("removed enrollment, revoked relationships, withdrawn participants and deleting accounts deny writes and receipt replay", async () => {
  const e = await create();
  const payload = response(e);
  await call("p209-parent1", "respondToEvent", payload);
  for (const team of ["p209-a", "p209-b"])
    await db
      .doc(`teams/${team}/roster/p209-child-a`)
      .update({ status: "removed" });
  assert.equal((await read(e)).items.length, 1);
  await deny(call("p209-parent1", "respondToEvent", payload));
  for (const team of ["p209-a", "p209-b"])
    await db
      .doc(`teams/${team}/roster/p209-child-a`)
      .update({ status: "active" });
  await db
    .doc(grant("p209-child-a", "p209-parent1"))
    .update({ status: "revoked" });
  await deny(call("p209-parent1", "respondToEvent", payload));
  await db
    .doc(grant("p209-child-a", "p209-parent1"))
    .update({ status: "active", "permissions.respond": false });
  await deny(call("p209-parent1", "respondToEvent", payload));
  await db
    .doc(grant("p209-child-a", "p209-parent1"))
    .update({ "permissions.respond": true });
  await db.doc(part("p209-child-a")).update({ status: "archived" });
  await deny(call("p209-parent1", "respondToEvent", payload));
  await db.doc(part("p209-child-a")).update({ status: "active" });
  await db.doc("accountDeletionJobs/p209-parent1").set({ status: "pending" });
  await deny(call("p209-parent1", "respondToEvent", payload));
  await db.doc("accountDeletionJobs/p209-parent1").delete();
  assert.equal(
    (await db.doc(`events/${e.id}/availability/p209-child-a`).get()).data()
      .revision,
    1,
  );
});
test("publication, tenant references, rollout flags and effective resource closures fail closed", async () => {
  const staged = await create({ publicationState: "staged" });
  await deny(read(staged));
  await deny(call("p209-parent1", "respondToEvent", response(staged)));
  const e = await create();
  const payload = response(e);
  await call("p209-parent1", "respondToEvent", payload);
  await db
    .doc(`events/${e.id}`)
    .update({ publicationOperationId: "p209-uncommitted" });
  await deny(read(e));
  await deny(call("p209-parent1", "respondToEvent", payload));
  await db.doc(`events/${e.id}`).update({ publicationOperationId: null });
  await db.doc("teams/p209-b").update({ orgId: "foreign" });
  await deny(call("p209-parent1", "respondToEvent", payload));
  await db.doc("teams/p209-b").update({ orgId: scope.orgId });
  await db
    .doc("organizations/p209-org")
    .update({ "features.households": false });
  await deny(call("p209-parent1", "respondToEvent", payload));
  await db
    .doc("organizations/p209-org")
    .update({ "features.households": true });
  await db
    .doc(`events/${e.id}`)
    .update({ facilityId: "p209-facility", resourceId: "p209-field" });
  await db
    .doc("organizations/p209-org/closures/p209-closed")
    .set({
      ...meta,
      orgId: scope.orgId,
      facilityId: "p209-facility",
      resourceIds: ["p209-field"],
      startsAt: "2026-12-20T22:00:00.000Z",
      endsAt: "2026-12-21T01:00:00.000Z",
      status: "applied",
    });
  await assert.rejects(
    call("p209-parent2", "respondToEvent", response(e, "p209-child-b")),
    (e) => e.details.domainCode === "RSVP_CLOSED",
  );
  assert.ok((await read(e)).items.every((i) => !i.canRespond));
});
test("server deadline, lifecycle closure, archive policy and note validation are enforced", async () => {
  const e = await create();
  await assert.rejects(
    call(
      "p209-parent1",
      "respondToEvent",
      response(e, "p209-child-a", { lateNote: "x".repeat(241) }),
    ),
    { code: "functions/invalid-argument" },
  );
  await assert.rejects(
    call("p209-parent1", "respondToEvent", {
      ...response(e),
      actorUid: "spoof",
    }),
    { code: "functions/invalid-argument" },
  );
  await deny(
    call(
      "p209-coach",
      "setEventRsvpDeadline",
      req({ eventId: e.id, expectedRevision: 1, deadline: null }),
    ),
  );
  await assert.rejects(
    call(
      "p209-admin",
      "setEventRsvpDeadline",
      req({
        eventId: e.id,
        expectedRevision: 1,
        deadline: "2026-12-21T00:00:00.000Z",
      }),
    ),
    { code: "functions/invalid-argument" },
  );
  await call(
    "p209-admin",
    "setEventRsvpDeadline",
    req({
      eventId: e.id,
      expectedRevision: 1,
      deadline: "2020-01-01T00:00:00.000Z",
    }),
  );
  await assert.rejects(
    call("p209-parent1", "respondToEvent", response(e)),
    (e) => e.details.domainCode === "RSVP_CLOSED",
  );
  assert.equal((await read(e)).items[0].canRespond, false);
  for (const status of ["cancelled", "postponed", "completed"]) {
    const other = await create();
    await db.doc(`events/${other.id}`).update({ status });
    await assert.rejects(
      call("p209-parent1", "respondToEvent", response(other)),
      (e) => e.details.domainCode === "RSVP_CLOSED",
    );
  }
  const archived = await create();
  await db.doc("teams/p209-a").update({ status: "archived" });
  await assert.rejects(
    call("p209-parent1", "respondToEvent", response(archived)),
    (e) => e.details.domainCode === "RSVP_CLOSED",
  );
  await db.doc("teams/p209-a").update({ status: "active" });
});
test("admin explicitly grants response access without enabling profile edits, with viewSchedule required", async () => {
  const p = await db.doc(part("p209-child-b")).get();
  await call(
    "p209-admin",
    "approveGuardian",
    req({
      orgId: scope.orgId,
      participantId: p.id,
      userId: "p209-viewer",
      expectedRevision: p.data().revision,
      permissions: {
        viewSchedule: true,
        viewProfile: true,
        editProfile: false,
        respond: true,
      },
    }),
  );
  const e = await create();
  await call("p209-viewer", "respondToEvent", response(e, p.id));
  await assert.rejects(
    call(
      "p209-admin",
      "approveGuardian",
      req({
        orgId: scope.orgId,
        participantId: p.id,
        userId: "p209-viewer",
        expectedRevision: p.data().revision + 1,
        permissions: {
          viewSchedule: false,
          viewProfile: true,
          editProfile: false,
          respond: true,
        },
      }),
    ),
    { code: "functions/invalid-argument" },
  );
});
