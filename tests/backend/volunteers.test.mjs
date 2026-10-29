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

const users = ["p38-coach", "p38-revoked", "p38-guardian", "p38-guardian2", "p38-viewer", "p38-child", "p38-player", "p38-outsider", "p38-admin"];
let admin;
let db;
let seq = 0;
const apps = {};
const call = async (uid, name, data) => (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const deny = (promise) => assert.rejects(promise, { code: "functions/permission-denied" });
const domain = (promise, domainCode) =>
  assert.rejects(promise, (error) => error.details?.domainCode === domainCode);
const scope = { orgId: "p38-org", programId: "p38-program", seasonId: "p38-season", divisionId: "p38-division" };
const meta = () => ({ schemaVersion: 2, revision: 1, status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
const eventId = "p38-match";
const teamId = "p38-home";
const rid = () => `p38-${++seq}`;
const envelope = (expectedRevision, payload, requestId = rid()) =>
  ({ requestId, orgId: scope.orgId, resourceId: eventId, expectedRevision, payload: { teamId, ...payload } });
const createSlot = (uid, payload = {}) =>
  call(uid, "saveVolunteerSlot", envelope(0, { kind: "snacks", title: "Halftime oranges", capacity: 1, ...payload }));
const claim = (uid, slotId, requestId = rid(), alias = `Alias ${uid.slice(4)}`) =>
  call(uid, "claimVolunteerSlot", envelope(null, { slotId, displayAlias: alias, showAlias: true }, requestId));
const release = (uid, slotId, assigneeKey) =>
  call(uid, "releaseVolunteerSlot", envelope(null, { slotId, ...(assigneeKey ? { assigneeKey } : {}) }));
const view = (uid) => call(uid, "getEventVolunteers", { eventId, teamId });
const slotDoc = async (slotId) => (await db.doc(`events/${eventId}/volunteerSlots/${slotId}`).get()).data();

before(async () => {
  admin = adminApp({ projectId }, "p38-admin-app");
  db = getFirestore(admin);
  for (const uid of users) {
    const app = initializeApp({ projectId, apiKey: "demo-key" }, uid);
    apps[uid] = app;
    connectAuthEmulator(getAuth(app), "http://127.0.0.1:9099", { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), "127.0.0.1", 5001);
    connectFirestoreEmulator(clientDb(app), "127.0.0.1", 8080);
    await adminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password: "SyntheticPassword123!" }).catch(() => {});
    await db.doc(`users/${uid}`).set({ uid, appRole: "user" });
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, "SyntheticPassword123!");
  }
});

after(async () => {
  await Promise.all(Object.values(apps).map((app) => deleteApp(app)));
  if (admin) await deleteAdmin(admin);
});

beforeEach(async () => {
  for (const slot of (await db.collection(`events/${eventId}/volunteerSlots`).get()).docs) await db.recursiveDelete(slot.ref);
  for (const row of (await db.collection(`organizations/${scope.orgId}/outbox`).get()).docs) await row.ref.delete();
  const batch = db.batch();
  batch.set(db.doc(`organizations/${scope.orgId}`), { ...meta(), name: "Synthetic league", features: { organizationV2: true, households: true } });
  for (const [kind, name] of [["programs", scope.programId], ["seasons", scope.seasonId], ["divisions", scope.divisionId]]) {
    batch.set(db.doc(`organizations/${scope.orgId}/${kind}/${name}`), { ...meta(), ...scope, name });
  }
  batch.set(db.doc(`organizations/${scope.orgId}/members/p38-admin`), { ...meta(), orgId: scope.orgId, roles: ["orgAdmin"], programIds: [] });
  for (const id of [teamId, "p38-away"]) batch.set(db.doc(`teams/${id}`), { ...meta(), ...scope, name: id });
  const member = (uid, roles, status = "active") =>
    batch.set(db.doc(`teamMembers/${teamId}_${uid}`), { ...meta(), orgId: scope.orgId, teamId, userId: uid, roles, status });
  member("p38-coach", ["coach"]);
  member("p38-revoked", ["coach"], "revoked");
  member("p38-player", ["player"]);
  for (const [participantId, linkedUserId] of [["p38-a", null], ["p38-b", null], ["p38-c", "p38-child"]]) {
    batch.set(db.doc(`organizations/${scope.orgId}/participants/${participantId}`), {
      ...meta(), orgId: scope.orgId, displayName: `Synthetic ${participantId}`, kind: "youth", linkedUserId,
    });
    batch.set(db.doc(`teams/${teamId}/roster/${participantId}`), { ...meta(), orgId: scope.orgId, participantId });
  }
  const guardian = (participantId, uid, permissions) =>
    batch.set(db.doc(`organizations/${scope.orgId}/participants/${participantId}/guardians/${uid}`), {
      ...meta(), orgId: scope.orgId, participantId, userId: uid, permissions: { viewProfile: true, editProfile: false, ...permissions },
    });
  guardian("p38-a", "p38-guardian", { viewSchedule: true, respond: true });
  guardian("p38-b", "p38-guardian2", { viewSchedule: true, respond: true });
  guardian("p38-b", "p38-viewer", { viewSchedule: true, respond: false });
  batch.set(db.doc(`events/${eventId}`), {
    ...meta(), ...scope, title: "Synthetic match", type: "match", teamId, teamIds: [teamId, "p38-away"], homeTeamId: teamId, awayTeamId: "p38-away",
    startsAt: Timestamp.fromDate(new Date("2027-03-20T23:00:00Z")), endsAt: Timestamp.fromDate(new Date("2027-03-21T00:30:00Z")),
    timeZone: "America/Chicago", status: "scheduled", publicationState: "published", publicationOperationId: null, deletedAt: null,
  });
  await batch.commit();
});

test("coach creates a slot, a guardian claims it and viewers see only the chosen alias", async () => {
  const { slotId, revision, state } = await createSlot("p38-coach", { capacity: 2 });
  assert.equal(revision, 1);
  assert.equal(state, "open");
  assert.equal((await claim("p38-guardian", slotId, rid(), "  Sam   R. ")).state, "claimed");
  const own = await view("p38-guardian");
  assert.equal(own.canClaim, true);
  assert.equal(own.canManage, false);
  assert.deepEqual(own.slots[0].assignees, [{ alias: "Sam R." }]);
  assert.deepEqual(own.slots[0].ownClaim, { alias: "Sam R.", status: "active" });
  assert.equal(own.slots[0].openCount, 1);
  assert.equal(own.slots[0].state, "open");
  // A view-only household and a team member see the list but cannot claim.
  const household = await view("p38-viewer");
  assert.equal(household.canClaim, false);
  assert.equal(household.slots[0].ownClaim, null);
  const player = await view("p38-player");
  assert.deepEqual(player.slots[0].assignees, [{ alias: "Sam R." }]);
  const serialized = JSON.stringify([household, player, own]);
  for (const secret of ["p38-guardian", "example.test", "assigneeKey", "p38-coach"]) assert.equal(serialized.includes(secret), false, secret);
  const coach = await view("p38-coach");
  assert.equal(coach.canManage, true);
  assert.equal(typeof coach.slots[0].assignees[0].assigneeKey, "string");
  // The stored slot document carries aliases and opaque keys, never claimant UIDs.
  const stored = await slotDoc(slotId);
  assert.equal(JSON.stringify(stored.assignees).includes("p38-guardian"), false);
  assert.equal(stored.claimedCount, 1);
});

test("two last-seat claims produce exactly one winner", async () => {
  const { slotId } = await createSlot("p38-coach", { capacity: 1 });
  const results = await Promise.allSettled([claim("p38-guardian", slotId), claim("p38-guardian2", slotId)]);
  const won = results.filter((row) => row.status === "fulfilled");
  const lost = results.filter((row) => row.status === "rejected");
  assert.equal(won.length, 1);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].reason.details?.domainCode, "VOLUNTEER_SLOT_FULL");
  const stored = await slotDoc(slotId);
  assert.equal(stored.claimedCount, 1);
  assert.equal(stored.openCount, 0);
  assert.equal(stored.assignees.length, 1);
  assert.equal((await view("p38-player")).slots[0].state, "full");
});

test("duplicate commands replay the original outcome and repeated releases are no-ops", async () => {
  const { slotId } = await createSlot("p38-coach", { capacity: 3 });
  const requestId = rid();
  const first = await claim("p38-guardian", slotId, requestId);
  assert.deepEqual(await claim("p38-guardian", slotId, requestId), first);
  await domain(claim("p38-guardian", slotId, requestId, "Different"), "REQUEST_ID_REUSED");
  assert.equal((await claim("p38-guardian", slotId)).state, "claimed");
  assert.equal((await slotDoc(slotId)).claimedCount, 1);
  assert.equal((await release("p38-guardian", slotId)).state, "released");
  assert.equal((await release("p38-guardian", slotId)).state, "released");
  const stored = await slotDoc(slotId);
  assert.equal(stored.claimedCount, 0);
  assert.equal(stored.openCount, 3);
  assert.deepEqual(stored.assignees, []);
  assert.equal((await view("p38-guardian")).slots[0].ownClaim, null);
  // Reclaiming after release takes a seat again.
  await claim("p38-guardian", slotId);
  assert.equal((await slotDoc(slotId)).claimedCount, 1);
});

test("revoked adults, children, players, outsiders and other tenants cannot claim", async () => {
  const { slotId } = await createSlot("p38-coach", { capacity: 5 });
  const requestId = rid();
  await claim("p38-guardian", slotId, requestId);
  await db.doc(`organizations/${scope.orgId}/participants/p38-a/guardians/p38-guardian`).update({ status: "revoked" });
  await deny(claim("p38-guardian", slotId, requestId));
  await deny(view("p38-guardian"));
  await deny(release("p38-guardian", slotId));
  // A participant's own linked account is never a volunteering adult.
  await deny(claim("p38-child", slotId));
  await domain(claim("p38-player", slotId), "VOLUNTEER_NOT_ELIGIBLE");
  await domain(claim("p38-viewer", slotId), "VOLUNTEER_NOT_ELIGIBLE");
  await deny(claim("p38-outsider", slotId));
  await deny(view("p38-outsider"));
  await deny(call("p38-guardian2", "claimVolunteerSlot", { ...envelope(null, { slotId, displayAlias: "B", showAlias: true }), orgId: "p38-other-org" }));
  // Staff manage slots only through an active coach assignment; organization admins and revoked coaches are denied.
  await deny(createSlot("p38-revoked"));
  await deny(createSlot("p38-admin"));
  await deny(createSlot("p38-guardian2"));
  // The coach can still remove the revoked adult's assignment by its opaque key.
  const key = (await view("p38-coach")).slots[0].assignees[0].assigneeKey;
  assert.equal((await release("p38-coach", slotId, key)).state, "released");
  assert.equal((await slotDoc(slotId)).claimedCount, 0);
  await deny(release("p38-guardian2", slotId, key));
});

test("aliases need consent and cannot carry contact details", async () => {
  const { slotId } = await createSlot("p38-coach");
  await assert.rejects(call("p38-guardian", "claimVolunteerSlot", envelope(null, { slotId, displayAlias: "Sam", showAlias: false })), { code: "functions/invalid-argument" });
  for (const alias of ["sam@example.test", "Call 555 123 4567", "www.example.test"]) {
    await assert.rejects(claim("p38-guardian", slotId, rid(), alias), { code: "functions/invalid-argument" });
  }
  assert.equal((await slotDoc(slotId)).claimedCount, 0);
});

test("cancelled slots and events show cancelled assignments and block claims", async () => {
  const first = await createSlot("p38-coach", { capacity: 2 });
  const second = await createSlot("p38-coach", { kind: "setup", title: "Field setup", capacity: 2 });
  await claim("p38-guardian", first.slotId);
  await claim("p38-guardian", second.slotId);
  const cancelled = await call("p38-coach", "saveVolunteerSlot", envelope(2, { slotId: first.slotId, action: "cancel" }));
  assert.equal(cancelled.state, "cancelled");
  await domain(claim("p38-guardian2", first.slotId), "VOLUNTEER_SLOT_CANCELLED");
  await domain(call("p38-coach", "saveVolunteerSlot", envelope(3, { slotId: first.slotId, kind: "snacks", title: "Again", capacity: 2 })), "VOLUNTEER_SLOT_CANCELLED");
  const outbox = (await db.collection(`organizations/${scope.orgId}/outbox`).get()).docs.map((row) => row.data());
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].templateKey, "volunteerSlotCancelled");
  assert.deepEqual(outbox[0].audience, { teamIds: [teamId] });
  assert.equal(JSON.stringify(outbox[0]).includes("Alias"), false);
  assert.equal(JSON.stringify(outbox[0]).includes("p38-guardian"), false);
  const shown = await view("p38-guardian");
  assert.deepEqual(shown.slots.map((slot) => [slot.state, slot.ownClaim?.status]), [["cancelled", "cancelled"], ["open", "active"]]);
  await db.doc(`events/${eventId}`).update({ status: "cancelled" });
  await domain(claim("p38-guardian2", second.slotId), "VOLUNTEER_SLOT_CANCELLED");
  assert.deepEqual((await view("p38-guardian")).slots.map((slot) => slot.ownClaim?.status), ["cancelled", "cancelled"]);
  // Assignments and claims are retained, not deleted, so the record survives cancellation.
  assert.equal((await slotDoc(second.slotId)).claimedCount, 1);
});

test("deadlines close sign-up and capacity cannot drop below active claims", async () => {
  const { slotId } = await createSlot("p38-coach", { capacity: 2 });
  await claim("p38-guardian", slotId);
  await claim("p38-guardian2", slotId);
  await domain(call("p38-coach", "saveVolunteerSlot", envelope(3, { slotId, kind: "snacks", title: "Oranges", capacity: 1 })), "VOLUNTEER_CAPACITY_BELOW_CLAIMS");
  await domain(call("p38-coach", "saveVolunteerSlot", envelope(1, { slotId, kind: "snacks", title: "Oranges", capacity: 3 })), "STALE_REVISION");
  await assert.rejects(call("p38-coach", "saveVolunteerSlot", envelope(3, { slotId, kind: "snacks", title: "Oranges", capacity: 3, claimDeadline: "2027-04-01T00:00:00Z" })), { code: "functions/invalid-argument" });
  const past = await call("p38-coach", "saveVolunteerSlot", envelope(3, { slotId, kind: "snacks", title: "Oranges", capacity: 3, claimDeadline: "2026-01-01T00:00:00Z" }));
  assert.equal(past.revision, 4);
  await domain(claim("p38-coach", slotId), "VOLUNTEER_CLOSED");
  await domain(release("p38-guardian", slotId), "VOLUNTEER_CLOSED");
  assert.equal((await view("p38-player")).slots[0].state, "closed");
});

test("volunteer documents stay closed to direct client reads", async () => {
  const { slotId } = await createSlot("p38-coach");
  await claim("p38-guardian", slotId);
  for (const uid of ["p38-coach", "p38-guardian", "p38-player"]) {
    await assert.rejects(getDoc(doc(clientDb(apps[uid]), `events/${eventId}/volunteerSlots/${slotId}`)), { code: "permission-denied" });
    await assert.rejects(getDoc(doc(clientDb(apps[uid]), `events/${eventId}/volunteerSlots/${slotId}/claims/p38-guardian`)), { code: "permission-denied" });
  }
});
