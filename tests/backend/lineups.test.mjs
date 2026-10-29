import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { deleteApp, initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from "firebase/auth";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";
import { getFirestore as clientDb, connectFirestoreEmulator, doc, getDoc } from "firebase/firestore";
import { projectId, requireEmulators } from "./fixtures.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { initializeApp: adminApp, deleteApp: deleteAdmin } = require("firebase-admin/app");
const { getAuth: adminAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
requireEmulators();

const users = ["p33-coach", "p33-coach2", "p33-revoked", "p33-guardian", "p33-outsider", "p33-admin", "p33-player", "p33-support"];
let admin;
let db;
let seq = 0;
const apps = {};
const call = async (uid, name, data) => (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const deny = (promise) => assert.rejects(promise, { code: "functions/permission-denied" });
const domain = (promise, domainCode) =>
  assert.rejects(promise, (error) => error.details?.domainCode === domainCode);
const scope = { orgId: "p33-org", programId: "p33-program", seasonId: "p33-season", divisionId: "p33-division" };
const meta = () => ({ schemaVersion: 2, revision: 1, status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
const eventId = "p33-match";
const teamId = "p33-home";
const people = ["p33-a", "p33-b", "p33-c", "p33-d"];
const unit = (slots) => [{ unitId: "starting", slots }];
const slot = (slotId, participantId, x = 0.5, y = 0.5) => ({ slotId, participantId, x, y });
const save = (uid, expectedRevision, payload = {}, requestId = `p33-${++seq}`) =>
  call(uid, "saveLineup", {
    requestId,
    orgId: scope.orgId,
    resourceId: eventId,
    expectedRevision,
    payload: {
      teamId,
      sportPresetId: "soccer",
      units: unit([slot("gk", "p33-a", 0.5, 0.91), slot("st", "p33-b", 1.4, -0.2)]),
      bench: ["p33-d", "p33-c"],
      note: "Synthetic private coaching note",
      ...payload,
    },
  });
const publish = (uid, expectedRevision, action = "publish") =>
  call(uid, "publishLineup", { requestId: `p33-${++seq}`, orgId: scope.orgId, resourceId: eventId, expectedRevision, payload: { teamId, action } });
const read = (uid) => call(uid, "getLineup", { eventId, teamId });
const view = (uid, participantId) => call(uid, "getLineupView", { eventId, teamId, ...(participantId ? { participantId } : {}) });

before(async () => {
  admin = adminApp({ projectId }, "p33-admin-app");
  db = getFirestore(admin);
  for (const uid of users) {
    const app = initializeApp({ projectId, apiKey: "demo-key" }, uid);
    apps[uid] = app;
    connectAuthEmulator(getAuth(app), "http://127.0.0.1:9099", { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), "127.0.0.1", 5001);
    connectFirestoreEmulator(clientDb(app), "127.0.0.1", 8080);
    await adminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password: "SyntheticPassword123!" }).catch(() => {});
    await db.doc(`users/${uid}`).set({ uid, appRole: uid === "p33-support" ? "superAdmin" : "user" });
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, "SyntheticPassword123!");
  }
});

after(async () => {
  await Promise.all(Object.values(apps).map((app) => deleteApp(app)));
  if (admin) await deleteAdmin(admin);
});

beforeEach(async () => {
  const batch = db.batch();
  for (const path of [`events/${eventId}/coaching/${teamId}`, `events/${eventId}/coaching/${teamId}/notes/lineup`, `events/${eventId}/lineupViews/${teamId}`]) {
    batch.delete(db.doc(path));
  }
  batch.set(db.doc("organizations/p33-org"), { ...meta(), name: "Synthetic league", features: { organizationV2: true, households: true } });
  for (const [kind, name] of [["programs", scope.programId], ["seasons", scope.seasonId], ["divisions", scope.divisionId]]) {
    batch.set(db.doc(`organizations/p33-org/${kind}/${name}`), { ...meta(), ...scope, name });
  }
  batch.set(db.doc("organizations/p33-org/members/p33-admin"), { ...meta(), orgId: scope.orgId, roles: ["orgAdmin"], programIds: [] });
  for (const id of [teamId, "p33-away"]) batch.set(db.doc(`teams/${id}`), { ...meta(), ...scope, name: id });
  const member = (uid, roles, status = "active") =>
    batch.set(db.doc(`teamMembers/${teamId}_${uid}`), { ...meta(), orgId: scope.orgId, teamId, userId: uid, roles, status });
  member("p33-coach", ["coach"]);
  member("p33-coach2", ["coach"]);
  member("p33-revoked", ["coach"], "revoked");
  member("p33-player", ["player"]);
  for (const participantId of people) {
    batch.set(db.doc(`organizations/p33-org/participants/${participantId}`), {
      ...meta(), orgId: scope.orgId, displayName: `Synthetic ${participantId.slice(4).toUpperCase()}`, kind: "youth", linkedUserId: null,
    });
    batch.set(db.doc(`teams/${teamId}/roster/${participantId}`), { ...meta(), orgId: scope.orgId, participantId });
  }
  batch.set(db.doc("organizations/p33-org/participants/p33-a/guardians/p33-guardian"), {
    ...meta(), orgId: scope.orgId, participantId: "p33-a", userId: "p33-guardian",
    permissions: { viewSchedule: true, respond: true, viewProfile: true, editProfile: false },
  });
  batch.set(db.doc(`events/${eventId}`), {
    ...meta(), ...scope, title: "Synthetic match", type: "match", teamId, teamIds: [teamId, "p33-away"], homeTeamId: teamId, awayTeamId: "p33-away",
    startsAt: Timestamp.fromDate(new Date("2026-12-20T23:00:00Z")), endsAt: Timestamp.fromDate(new Date("2026-12-21T00:30:00Z")),
    timeZone: "America/Chicago", status: "scheduled", publicationState: "published", publicationOperationId: null, deletedAt: null,
  });
  await batch.commit();
});

test("coach saves and reloads clamped positions, bench order and a private note", async () => {
  const empty = await read("p33-coach");
  assert.equal(empty.revision, 0);
  assert.equal(empty.sportPresetId, null);
  assert.deepEqual(empty.roster.map((r) => r.participantId), people);
  const saved = await save("p33-coach", 0);
  assert.deepEqual(saved.revision, 1);
  assert.equal(saved.state, "private");
  const loaded = await read("p33-coach");
  assert.equal(loaded.revision, 1);
  assert.deepEqual(loaded.bench, ["p33-d", "p33-c"]);
  assert.deepEqual(loaded.units, unit([slot("gk", "p33-a", 0.5, 0.91), slot("st", "p33-b", 1, 0)]));
  assert.equal(loaded.note, "Synthetic private coaching note");
  assert.deepEqual(loaded.unavailableParticipantIds, []);
  assert.equal(loaded.publication.state, "private");
});

test("lineup validation rejects duplicates within a unit, unknown slots and bench overlap", async () => {
  await assert.rejects(save("p33-coach", 0, { units: unit([slot("gk", "p33-a"), slot("st", "p33-a")]) }), { code: "functions/invalid-argument" });
  await assert.rejects(save("p33-coach", 0, { units: unit([slot("qb", "p33-a")]) }), { code: "functions/invalid-argument" });
  await assert.rejects(save("p33-coach", 0, { bench: ["p33-a"] }), { code: "functions/invalid-argument" });
  await assert.rejects(save("p33-coach", 0, { bench: ["p33-c", "p33-c"] }), { code: "functions/invalid-argument" });
  await assert.rejects(save("p33-coach", 0, { units: [] }), { code: "functions/invalid-argument" });
  await assert.rejects(save("p33-coach", 0, { note: "x".repeat(2001) }), { code: "functions/invalid-argument" });
  await assert.rejects(save("p33-coach", 0, { bench: ["p33-ghost"] }), (e) => e.details?.domainCode === "PARTICIPANT_UNAVAILABLE");
  // Football units are independent: one participant may hold a slot in each unit.
  const football = await save("p33-coach", 0, {
    sportPresetId: "football",
    units: [
      { unitId: "offense", slots: [slot("qb", "p33-a")] },
      { unitId: "defense", slots: [slot("mlb", "p33-a")] },
      { unitId: "specialTeams", slots: [slot("k", "p33-a")] },
    ],
    bench: ["p33-b"],
  });
  assert.equal(football.revision, 1);
});

test("simultaneous editors cannot overwrite each other and duplicate requests replay", async () => {
  const [first, second] = await Promise.allSettled([
    save("p33-coach", 0, { bench: ["p33-c"] }),
    save("p33-coach2", 0, { bench: ["p33-d"] }),
  ]);
  const outcomes = [first, second];
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  const rejected = outcomes.find((o) => o.status === "rejected").reason;
  assert.equal(rejected.code, "functions/aborted");
  assert.equal(rejected.details.domainCode, "STALE_REVISION");
  assert.equal(rejected.details.currentRevision, 1);
  const replayed = await save("p33-coach", 1, {}, "p33-replay");
  assert.deepEqual(await save("p33-coach", 1, {}, "p33-replay"), replayed);
  await domain(save("p33-coach", 1, { bench: ["p33-c"] }, "p33-replay"), "REQUEST_ID_REUSED");
  assert.equal((await read("p33-coach")).revision, 2);
});

test("roster departure marks the slot unavailable and blocks save and publish until replaced", async () => {
  await save("p33-coach", 0);
  await db.doc(`teams/${teamId}/roster/p33-b`).update({ status: "removed" });
  const loaded = await read("p33-coach");
  assert.deepEqual(loaded.unavailableParticipantIds, ["p33-b"]);
  assert.equal(loaded.roster.find((r) => r.participantId === "p33-b").available, false);
  assert.deepEqual(loaded.units[0].slots.map((s) => s.participantId), ["p33-a", "p33-b"]);
  await domain(save("p33-coach", 1), "PARTICIPANT_UNAVAILABLE");
  await domain(publish("p33-coach", 1), "PARTICIPANT_UNAVAILABLE");
  const replaced = await save("p33-coach", 1, { units: unit([slot("gk", "p33-a"), slot("st", "p33-c")]), bench: ["p33-d"] });
  assert.equal(replaced.revision, 2);
});

test("only active assigned coaches reach private lineups and notes", async () => {
  await save("p33-coach", 0);
  for (const uid of ["p33-revoked", "p33-guardian", "p33-outsider", "p33-admin", "p33-player", "p33-support"]) {
    await deny(read(uid));
    await deny(save(uid, 1));
    await deny(publish(uid, 1));
  }
  await db.doc(`teamMembers/${teamId}_p33-coach2`).update({ status: "revoked" });
  await deny(read("p33-coach2"));
  for (const uid of ["p33-coach", "p33-guardian", "p33-admin", "p33-support"]) {
    const client = clientDb(apps[uid]);
    for (const path of [`events/${eventId}/coaching/${teamId}`, `events/${eventId}/coaching/${teamId}/notes/lineup`, `events/${eventId}/lineupViews/${teamId}`]) {
      await assert.rejects(getDoc(doc(client, path)), { code: "permission-denied" });
    }
  }
});

test("publication is explicit, sanitized for families and retractable", async () => {
  await save("p33-coach", 0);
  assert.deepEqual(await view("p33-guardian", "p33-a"), { state: "unpublished" });
  const published = await publish("p33-coach", 1);
  assert.deepEqual(published, { requestId: published.requestId, revision: 2, state: "published" });
  const family = await view("p33-guardian", "p33-a");
  assert.equal(family.state, "published");
  assert.equal(family.publicationRevision, 1);
  assert.deepEqual(family.units[0].slots[0], { slotId: "gk", participantId: "p33-a", displayName: "Synthetic A", x: 0.5, y: 0.91 });
  assert.deepEqual(family.bench.map((b) => b.participantId), ["p33-d", "p33-c"]);
  const serialized = JSON.stringify(family);
  assert.ok(!serialized.includes("Synthetic private coaching note"));
  assert.ok(!/note|updatedBy|authorUid|available/.test(serialized));
  assert.equal((await view("p33-player")).state, "published");
  assert.equal((await view("p33-admin")).state, "published");
  await deny(view("p33-guardian"));
  await deny(view("p33-guardian", "p33-b"));
  await deny(view("p33-outsider", "p33-a"));
  await deny(view("p33-revoked"));
  // Later private edits do not leak until the coach republishes.
  await save("p33-coach", 2, { bench: ["p33-c", "p33-d"] });
  assert.deepEqual((await view("p33-guardian", "p33-a")).bench.map((b) => b.participantId), ["p33-d", "p33-c"]);
  const state = await read("p33-coach");
  assert.equal(state.publication.sourceRevision, 2);
  assert.equal(state.revision, 3);
  await domain(publish("p33-coach", 2), "STALE_REVISION");
  await publish("p33-coach", 3, "retract");
  assert.deepEqual(await view("p33-guardian", "p33-a"), { state: "unpublished" });
  assert.equal((await read("p33-coach")).publication.state, "private");
});

test("publishing requires a saved lineup and an archived season blocks edits", async () => {
  await domain(publish("p33-coach", 0), "LINEUP_NOT_SAVED");
  await save("p33-coach", 0);
  await db.doc(`organizations/p33-org/seasons/${scope.seasonId}`).update({ status: "archived" });
  await domain(save("p33-coach", 1), "HIERARCHY_ARCHIVED");
  assert.equal((await read("p33-coach")).revision, 1);
});
