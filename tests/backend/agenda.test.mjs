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
  sequence = 0;
const apps = {};
const window = {
  from: "2026-11-01T05:00:00.000Z",
  to: "2026-11-02T06:00:00.000Z",
};
const call = async (uid, data = {}) =>
  (
    await httpsCallable(
      getFunctions(apps[uid]),
      "listHouseholdAgenda",
    )({ ...window, ...data })
  ).data;
const common = { schemaVersion: 2, revision: 1, status: "active" };
const permissions = { viewSchedule: true, viewProfile: false };
before(async () => {
  admin = adminApp({ projectId });
  db = getFirestore(admin);
  for (const uid of [
    "agenda-parent",
    "agenda-staff",
    "agenda-coach",
    "agenda-outsider",
    "agenda-self",
  ]) {
    const app = initializeApp({ projectId, apiKey: "demo-key" }, uid);
    apps[uid] = app;
    connectAuthEmulator(getAuth(app), "http://127.0.0.1:9099", {
      disableWarnings: true,
    });
    connectFunctionsEmulator(getFunctions(app), "127.0.0.1", 5001);
    await adminAuth(admin).createUser({
      uid,
      email: `${uid}@example.test`,
      password: "SyntheticPassword123!",
    });
    await db.doc(`users/${uid}`).set({ uid, appRole: "user" });
    await signInWithEmailAndPassword(
      getAuth(app),
      `${uid}@example.test`,
      "SyntheticPassword123!",
    );
  }
});
after(async () => {
  await Promise.all(Object.values(apps).map(deleteApp));
  await deleteAdmin(admin);
});
async function fixture() {
  const orgId = `agenda-org-${++sequence}`,
    teamId = `agenda-team-${sequence}`,
    seasonId = "fall",
    programId = "soccer",
    divisionId = "u12";
  const parent = { orgId, programId, seasonId, divisionId };
  const batch = db.batch();
  const set = (path, row) => batch.set(db.doc(path), row);
  set(`organizations/${orgId}`, {
    ...common,
    name: orgId,
    features: { households: true, organizationV2: true },
  });
  set(`organizations/${orgId}/programs/${programId}`, {
    ...common,
    orgId,
    name: "Soccer",
  });
  set(`organizations/${orgId}/seasons/${seasonId}`, {
    ...common,
    orgId,
    programId,
    name: "Fall",
  });
  set(`organizations/${orgId}/divisions/${divisionId}`, {
    ...common,
    ...parent,
    name: "U12",
  });
  set(`teams/${teamId}`, { ...common, ...parent, name: "Synthetic Stars" });
  for (const [participantId, displayName] of [
    ["jamie", "Jamie"],
    ["casey", "Casey"],
  ]) {
    set(`organizations/${orgId}/participants/${participantId}`, {
      ...common,
      orgId,
      displayName,
      kind: "youth",
      linkedUserId: null,
    });
    set(
      `organizations/${orgId}/participants/${participantId}/guardians/agenda-parent`,
      { ...common, orgId, participantId, userId: "agenda-parent", permissions },
    );
    set(`users/agenda-parent/participantLinks/${orgId}_${participantId}`, {
      orgId,
      participantId,
      status: "active",
    });
    set(`teams/${teamId}/roster/${participantId}`, {
      ...common,
      orgId,
      participantId,
    });
  }
  await batch.commit();
  return { orgId, teamId, parent };
}
async function event(f, id, fields = {}) {
  const row = {
    ...common,
    ...f.parent,
    teamId: f.teamId,
    teamIds: [f.teamId],
    title: id,
    type: "practice",
    startsAt: Timestamp.fromDate(new Date("2026-11-01T06:30:00.000Z")),
    endsAt: Timestamp.fromDate(new Date("2026-11-01T08:00:00.000Z")),
    timeZone: "America/Chicago",
    status: "scheduled",
    publicationState: "published",
    publicationOperationId: null,
    deletedAt: null,
    location: { name: "Demo field" },
    notes: "PRIVATE STAFF NOTE",
    privateProfile: { birthDate: "2016-01-01" },
    ...fields,
  };
  await db.doc(`events/${id}`).set(row);
  return row;
}
test("sibling multi-team events deduplicate, filters narrow, and response excludes private fields and unrelated labels", async () => {
  const f = await fixture(),
    second = `${f.teamId}-second`;
  await db
    .doc(`teams/${second}`)
    .set({ ...common, ...f.parent, name: "Second team" });
  await db
    .doc(`teams/${second}/roster/casey`)
    .set({ ...common, orgId: f.orgId, participantId: "casey" });
  await event(f, "agenda-shared", { teamIds: [f.teamId, second] });
  const result = await call("agenda-parent", { orgIds: [f.orgId] });
  assert.equal(result.items.length, 1);
  assert.deepEqual(
    result.items[0].participants.map((p) => p.displayName).sort(),
    ["Casey", "Jamie"],
  );
  assert.equal(result.items[0].teams.length, 2);
  assert.equal(result.teams.find((row) => row.id === f.teamId).divisionId, f.parent.divisionId);
  assert.equal(result.teams.find((row) => row.id === f.teamId).divisionName, "U12");
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(result).includes("birthDate"), false);
  const filtered = await call("agenda-parent", {
    participantRefs: [{ orgId: f.orgId, participantId: "jamie" }],
    teamIds: [f.teamId],
  });
  assert.deepEqual(
    filtered.items[0].participants.map((p) => p.displayName),
    ["Jamie"],
  );
  assert.equal(
    (await call("agenda-parent", { teamIds: ["foreign"] })).items.length,
    0,
  );
  assert.equal(
    (await call("agenda-parent", { orgIds: [f.orgId], eventTypes: ["match"] }))
      .items.length,
    0,
  );
  assert.deepEqual((await call("agenda-outsider")).items, []);
});
test("two-org personal access is independent of staff scope and foreign references are hidden", async () => {
  const a = await fixture(),
    b = await fixture();
  await event(a, "agenda-two-a");
  await event(b, "agenda-two-b");
  assert.deepEqual(
    (await call("agenda-parent", { orgIds: [a.orgId, b.orgId] })).items
      .map((e) => e.id)
      .sort(),
    ["agenda-two-a", "agenda-two-b"],
  );
  await db.doc(`organizations/${a.orgId}/members/agenda-staff`).set({
    ...common,
    orgId: a.orgId,
    roles: ["programStaff"],
    programIds: ["soccer"],
  });
  await db
    .doc(`users/agenda-staff/organizationLinks/${a.orgId}`)
    .set({ orgId: a.orgId });
  const other = "basketball";
  await db
    .doc(`organizations/${a.orgId}/programs/${other}`)
    .set({ ...common, orgId: a.orgId, name: "Other" });
  await db
    .doc(`organizations/${a.orgId}/seasons/other`)
    .set({ ...common, orgId: a.orgId, programId: other, name: "Other season" });
  await db
    .doc(`organizations/${a.orgId}/divisions/other`)
    .set({ ...common, orgId: a.orgId, programId: other, seasonId: "other" });
  const hidden = {
    ...a,
    teamId: "agenda-hidden",
    parent: {
      ...a.parent,
      programId: other,
      seasonId: "other",
      divisionId: "other",
    },
  };
  await db
    .doc(`teams/${hidden.teamId}`)
    .set({ ...common, ...hidden.parent, name: "Hidden team" });
  await event(hidden, "agenda-hidden-event");
  // Stale personal pointers and navigation teamAccess cannot create authority.
  await db
    .doc(`users/agenda-staff/teamAccess/${b.teamId}`)
    .set({ orgId: b.orgId, teamId: b.teamId, status: "active" });
  await db
    .doc(`users/agenda-staff/participantLinks/forged`)
    .set({ orgId: b.orgId, participantId: "jamie" });
  const staff = await call("agenda-staff");
  assert.deepEqual(
    staff.items.map((e) => e.id),
    ["agenda-two-a"],
  );
  assert.equal(staff.teams.length, 1);
  assert.equal(staff.items[0].participants.length, 0);
  await event(a, "agenda-cross-org", { teamIds: [a.teamId, b.teamId] });
  assert.equal(
    (await call("agenda-parent")).items.some(
      (e) => e.id === "agenda-cross-org",
    ),
    false,
  );
});
test("stable page boundaries deduplicate across streams, bind filters/accounts and invalidate on canonical revocation", async () => {
  const f = await fixture();
  for (const id of ["agenda-page-a", "agenda-page-b", "agenda-page-c"])
    await event(f, id);
  const query = { orgIds: [f.orgId], pageSize: 1 };
  const first = await call("agenda-parent", query),
    second = await call("agenda-parent", {
      ...query,
      cursor: first.nextCursor,
    });
  const third = await call("agenda-parent", {
    ...query,
    cursor: second.nextCursor,
  });
  assert.deepEqual(
    [first, second, third].map((p) => p.items[0].id),
    ["agenda-page-a", "agenda-page-b", "agenda-page-c"],
  );
  assert.equal(third.nextCursor, null);
  await assert.rejects(
    call("agenda-parent", {
      ...query,
      eventTypes: ["match"],
      cursor: first.nextCursor,
    }),
    (e) => e.details.domainCode === "AGENDA_CHANGED",
  );
  await assert.rejects(
    call("agenda-outsider", { ...query, cursor: first.nextCursor }),
    (e) => e.details.domainCode === "AGENDA_CHANGED",
  );
  await db
    .doc(`organizations/${f.orgId}/participants/jamie/guardians/agenda-parent`)
    .update({ status: "revoked" });
  await assert.rejects(
    call("agenda-parent", { ...query, cursor: first.nextCursor }),
    (e) => e.details.domainCode === "AGENDA_CHANGED",
  );
  assert.deepEqual(
    (await call("agenda-parent", query)).items[0].participants.map(
      (p) => p.displayName,
    ),
    ["Casey"],
  );
  await db.doc(`teams/${f.teamId}/roster/casey`).update({ status: "removed" });
  assert.equal((await call("agenda-parent", query)).items.length, 0);
});
test("pagination preserves sub-millisecond timestamp ordering without repeats or omissions", async () => {
  const f = await fixture();
  const seconds = Timestamp.fromDate(
    new Date("2026-11-01T06:30:00.000Z"),
  ).seconds;
  await event(f, "agenda-nano-z", { startsAt: new Timestamp(seconds, 1000) });
  await event(f, "agenda-nano-a", { startsAt: new Timestamp(seconds, 2000) });
  const query = { orgIds: [f.orgId], pageSize: 1 };
  const first = await call("agenda-parent", query);
  const second = await call("agenda-parent", {
    ...query,
    cursor: first.nextCursor,
  });
  assert.equal(first.items[0].id, "agenda-nano-z");
  assert.equal(second.items[0].id, "agenda-nano-a");
  assert.equal(second.nextCursor, null);
});
test("publication, lifecycle, archive and rollout gates exclude unsafe events", async () => {
  const f = await fixture();
  await event(f, "agenda-visible");
  for (const [id, fields] of Object.entries({
    staged: { publicationState: "staged" },
    cancelled: { status: "cancelled" },
    postponed: { status: "postponed" },
    completed: { status: "completed" },
    deleted: { deletedAt: Timestamp.now() },
    operation: { publicationOperationId: "uncommitted" },
    legacy: { schemaVersion: 1 },
    malformed: { timeZone: null },
    invalidEnd: {
      endsAt: Timestamp.fromDate(new Date("2026-11-01T05:00:00.000Z")),
    },
  }))
    await event(f, `agenda-${id}`, fields);
  const missingZone = await event(f, "agenda-missing-zone");
  delete missingZone.timeZone;
  await db.doc("events/agenda-missing-zone").set(missingZone);
  assert.deepEqual(
    (await call("agenda-parent", { orgIds: [f.orgId] })).items.map((e) => e.id),
    ["agenda-cancelled", "agenda-completed", "agenda-postponed", "agenda-visible"],
  );
  await db
    .doc(`organizations/${f.orgId}/seasons/fall`)
    .update({ status: "archived" });
  assert.equal(
    (await call("agenda-parent", { orgIds: [f.orgId] })).items.length,
    0,
  );
  const archived = await call("agenda-parent", {
    orgIds: [f.orgId],
    includeArchived: true,
  });
  assert.equal(archived.items.length, 4);
  assert.equal(archived.items[0].teams[0].archived, true);
  await db
    .doc(`organizations/${f.orgId}`)
    .update({ "features.households": false });
  assert.equal(
    (await call("agenda-parent", { orgIds: [f.orgId], includeArchived: true }))
      .items.length,
    0,
  );
});
test("DST fold uses canonical instants and exact half-open boundaries", async () => {
  const f = await fixture();
  for (const [id, time] of [
    ["before", "2026-11-01T04:59:59.999Z"],
    ["start", window.from],
    ["fold-a", "2026-11-01T06:30:00.000Z"],
    ["fold-b", "2026-11-01T07:30:00.000Z"],
    ["end", window.to],
  ]) {
    const startsAt = Timestamp.fromDate(new Date(time));
    await event(f, `agenda-dst-${id}`, {
      startsAt,
      endsAt: Timestamp.fromMillis(startsAt.toMillis() + 3600000),
    });
  }
  assert.deepEqual(
    (await call("agenda-parent", { orgIds: [f.orgId] })).items.map((e) => e.id),
    ["agenda-dst-start", "agenda-dst-fold-a", "agenda-dst-fold-b"],
  );
});
test("self and team roles use canonical records, legacy schedules signal setup and deletion is denied", async () => {
  const f = await fixture();
  await event(f, "agenda-roles");
  await db.doc(`teamMembers/${f.teamId}_agenda-coach`).set({
    ...common,
    orgId: f.orgId,
    teamId: f.teamId,
    userId: "agenda-coach",
    roles: ["coach"],
  });
  assert.ok(
    (await call("agenda-coach")).items.some((e) => e.id === "agenda-roles"),
  );
  await db
    .doc(`teamMembers/${f.teamId}_agenda-coach`)
    .update({ status: "revoked" });
  assert.equal((await call("agenda-coach")).items.length, 0);
  await db
    .doc(`organizations/${f.orgId}/participants/jamie`)
    .update({ linkedUserId: "agenda-self", kind: "adult" });
  // Reviewed migration creates explicit self identities before navigation pointers exist.
  assert.equal(
    (await call("agenda-self")).items[0].participants[0].displayName,
    "Jamie",
  );
  await db
    .doc("teamMembers/agenda-legacy_agenda-self")
    .set({ teamId: "agenda-legacy", userId: "agenda-self", role: "player" });
  assert.equal((await call("agenda-self")).setupRequired, true);
  await db.doc("accountDeletionJobs/agenda-self").set({ status: "deleting" });
  await assert.rejects(call("agenda-self"), {
    code: "functions/permission-denied",
  });
});
test("invalid windows, filters and cursors fail before data access", async () => {
  for (const fields of [
    { to: "2027-11-01T00:00:00.000Z" },
    { from: window.to },
    { from: "2026-11-01" },
    { pageSize: 101 },
    { pageSize: 0 },
    { eventTypes: ["cancelled"] },
    { participantRefs: [{ orgId: "x/y", participantId: "a" }] },
    { cursor: "not-json" },
    { includeArchived: "true" },
    { unknown: true },
  ])
    await assert.rejects(call("agenda-outsider", fields), {
      code: "functions/invalid-argument",
    });
});
