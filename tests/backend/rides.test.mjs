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

// Synthetic adults and contacts only. The transport policy below is a test fixture, not organization evidence.
const users = ["p39-coach", "p39-ga", "p39-ga2", "p39-gb", "p39-viewer", "p39-child", "p39-outsider", "p39-coordinator", "p39-staff"];
let admin;
let db;
let seq = 0;
const apps = {};
const call = async (uid, name, data) => (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const deny = (promise) => assert.rejects(promise, { code: "functions/permission-denied" });
const domain = (promise, domainCode) =>
  assert.rejects(promise, (error) => error.details?.domainCode === domainCode);
const scope = { orgId: "p39-org", programId: "p39-program", seasonId: "p39-season", divisionId: "p39-division" };
const meta = () => ({ schemaVersion: 2, revision: 1, status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
const eventId = "p39-match";
const teamId = "p39-home";
const rid = () => `p39-${++seq}`;
const envelope = (expectedRevision, payload, requestId = rid()) =>
  ({ requestId, orgId: scope.orgId, resourceId: eventId, expectedRevision, payload: { teamId, ...payload } });
const offer = (uid, payload = {}) =>
  call(uid, "saveRideRequest", envelope(0, { kind: "offer", direction: "toEvent", area: "North park", seats: 2, discoverable: true, ...payload }));
const need = (uid, participantIds, payload = {}) =>
  call(uid, "saveRideRequest", envelope(0, { kind: "need", direction: "toEvent", area: "Elm school", participantIds, discoverable: true, ...payload }));
const consent = (uid, ids, requestId = rid()) =>
  call(uid, "confirmRideArrangement", envelope(null, {
    ...ids, displayAlias: `Adult ${uid.slice(4)}`, contact: `synthetic-${uid}@example.test`, pickupNote: `Synthetic pickup for ${uid}`, shareContact: true,
  }, requestId));
const revoke = (uid, arrangementId) => call(uid, "revokeRideConsent", envelope(null, { arrangementId }));
const view = (uid) => call(uid, "getEventRides", { eventId, teamId });
const contacts = (uid, arrangementId) => call(uid, "getRideContacts", { eventId, teamId, arrangementId });
const ride = async (id) => (await db.doc(`events/${eventId}/rideRequests/${id}`).get()).data();
const arrangement = async (id) => (await db.doc(`events/${eventId}/rideArrangements/${id}`).get()).data();
const outbox = async () => (await db.collection(`organizations/${scope.orgId}/outbox`).get()).docs.map((row) => row.data());
const policyRef = () => db.doc(`organizations/${scope.orgId}/transportPolicy/current`);

/** Offer from the coach, request for child A from guardian A, then the coach confirms. */
async function confirmed(seats = 2) {
  const { rideId: offerId } = await offer("p39-coach", { seats });
  const { rideId: needId } = await need("p39-ga", ["p39-a"]);
  const { arrangementId } = await consent("p39-ga", { offerId, needId });
  assert.equal((await consent("p39-coach", { arrangementId })).state, "confirmed");
  return { offerId, needId, arrangementId };
}

before(async () => {
  admin = adminApp({ projectId });
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
  for (const name of ["rideRequests", "rideArrangements"]) {
    for (const row of (await db.collection(`events/${eventId}/${name}`).get()).docs) await db.recursiveDelete(row.ref);
  }
  for (const row of (await db.collection(`organizations/${scope.orgId}/outbox`).get()).docs) await row.ref.delete();
  const batch = db.batch();
  batch.set(db.doc(`organizations/${scope.orgId}`), { ...meta(), name: "Synthetic league", features: { organizationV2: true, households: true, rides: true } });
  batch.set(policyRef(), {
    schemaVersion: 2, orgId: scope.orgId, status: "active", policyVersion: "synthetic-1", consentVersion: "synthetic-consent-1",
    evidenceRef: "synthetic-test-fixture", coordinatorUids: ["p39-coordinator"], recordedAt: Timestamp.now(),
  });
  for (const [kind, name] of [["programs", scope.programId], ["seasons", scope.seasonId], ["divisions", scope.divisionId]]) {
    batch.set(db.doc(`organizations/${scope.orgId}/${kind}/${name}`), { ...meta(), ...scope, name });
  }
  for (const uid of ["p39-coordinator", "p39-staff"]) {
    batch.set(db.doc(`organizations/${scope.orgId}/members/${uid}`), { ...meta(), orgId: scope.orgId, roles: ["orgAdmin"], programIds: [] });
  }
  for (const id of [teamId, "p39-away"]) batch.set(db.doc(`teams/${id}`), { ...meta(), ...scope, name: id });
  batch.set(db.doc(`teamMembers/${teamId}_p39-coach`), { ...meta(), orgId: scope.orgId, teamId, userId: "p39-coach", roles: ["coach"] });
  for (const [participantId, linkedUserId] of [["p39-a", null], ["p39-b", null], ["p39-c", "p39-child"]]) {
    batch.set(db.doc(`organizations/${scope.orgId}/participants/${participantId}`), {
      ...meta(), orgId: scope.orgId, displayName: `Synthetic ${participantId}`, kind: "youth", linkedUserId,
    });
    batch.set(db.doc(`teams/${teamId}/roster/${participantId}`), { ...meta(), orgId: scope.orgId, participantId });
  }
  const guardian = (participantId, uid, permissions) =>
    batch.set(db.doc(`organizations/${scope.orgId}/participants/${participantId}/guardians/${uid}`), {
      ...meta(), orgId: scope.orgId, participantId, userId: uid, permissions: { viewProfile: true, editProfile: false, ...permissions },
    });
  guardian("p39-a", "p39-ga", { viewSchedule: true, respond: true });
  guardian("p39-a", "p39-ga2", { viewSchedule: true, respond: true });
  guardian("p39-b", "p39-gb", { viewSchedule: true, respond: true });
  guardian("p39-b", "p39-viewer", { viewSchedule: true, respond: false });
  batch.set(db.doc(`events/${eventId}`), {
    ...meta(), ...scope, title: "Synthetic match", type: "match", teamId, teamIds: [teamId, "p39-away"], homeTeamId: teamId, awayTeamId: "p39-away",
    startsAt: Timestamp.fromDate(new Date("2027-03-20T23:00:00Z")), endsAt: Timestamp.fromDate(new Date("2027-03-21T00:30:00Z")),
    timeZone: "America/Chicago", status: "scheduled", publicationState: "published", publicationOperationId: null, deletedAt: null,
  });
  await batch.commit();
});

test("rides stay disabled without the organization flag, a recorded policy and an active coordinator", async () => {
  await policyRef().delete();
  assert.deepEqual(await view("p39-ga"), { orgId: scope.orgId, eventId, teamId, eventStatus: "scheduled", enabled: false });
  await domain(offer("p39-coach"), "RIDES_DISABLED");
  await policyRef().set({ schemaVersion: 2, orgId: scope.orgId, status: "active", policyVersion: "synthetic-1", consentVersion: "c1", evidenceRef: "", coordinatorUids: ["p39-coordinator"] });
  assert.equal((await view("p39-ga")).enabled, false);
  await policyRef().set({ schemaVersion: 2, orgId: scope.orgId, status: "active", policyVersion: "synthetic-1", consentVersion: "c1", evidenceRef: "fixture", coordinatorUids: ["p39-outsider"] });
  assert.equal((await view("p39-ga")).enabled, false);
  await policyRef().update({ coordinatorUids: ["p39-coordinator"] });
  await db.doc(`organizations/${scope.orgId}`).update({ "features.rides": false });
  assert.equal((await view("p39-ga")).enabled, false);
  await domain(need("p39-ga", ["p39-a"]), "RIDES_DISABLED");
  await db.doc(`organizations/${scope.orgId}`).update({ "features.rides": true });
  assert.equal((await view("p39-ga")).enabled, true);
  await deny(view("p39-outsider"));
});

test("opt-in discovery is sanitized and contacts reach only the two consenting adults", async () => {
  const { rideId: offerId } = await offer("p39-coach", { seats: 3 });
  const { rideId: hidden } = await need("p39-gb", ["p39-b"], { discoverable: false });
  const { rideId: needId } = await need("p39-ga", ["p39-a"]);
  const household = await view("p39-gb");
  assert.deepEqual(household.matches.map((row) => Object.keys(row).sort()), [
    ["area", "direction", "kind", "revision", "rideId", "seats"], ["area", "direction", "kind", "revision", "rideId", "seats"],
  ]);
  assert.deepEqual(household.matches.map((row) => row.rideId).sort(), [offerId, needId].sort());
  assert.equal((await view("p39-coach")).matches.some((row) => row.rideId === hidden), false);
  assert.deepEqual((await view("p39-ga")).mine[0].participants, [{ participantId: "p39-a", displayName: "Synthetic p39-a" }]);
  // A non-discoverable request cannot be targeted by another household.
  await domain(consent("p39-coach", { offerId, needId: hidden }), "RIDE_MISSING");

  const { arrangementId, state } = await consent("p39-ga", { offerId, needId });
  assert.equal(state, "pending");
  const pending = (await view("p39-coach")).arrangements[0];
  assert.equal(pending.awaitingYou, true);
  assert.equal(pending.counterpartAlias, "Adult ga");
  await domain(contacts("p39-ga", arrangementId), "RIDE_CONTACT_UNAVAILABLE");
  assert.equal((await consent("p39-coach", { arrangementId })).state, "confirmed");
  assert.equal((await ride(offerId)).seatsReserved, 1);

  const driverView = await contacts("p39-coach", arrangementId);
  assert.deepEqual(driverView.counterpart, { role: "rider", alias: "Adult ga", contact: "synthetic-p39-ga@example.test", pickupNote: "Synthetic pickup for p39-ga" });
  assert.equal((await contacts("p39-ga", arrangementId)).counterpart.contact, "synthetic-p39-coach@example.test");
  // Unrelated households, the second guardian, view-only guardians, staff and the coordinator never receive contacts.
  for (const uid of ["p39-gb", "p39-ga2", "p39-viewer", "p39-staff", "p39-coordinator", "p39-outsider", "p39-child"]) await deny(contacts(uid, arrangementId));
  const coordinator = await view("p39-coordinator");
  assert.deepEqual(coordinator.coordination.arrangements, [{ arrangementId, state: "confirmed", direction: "toEvent", seats: 1, driverAlias: "Adult coach", riderAlias: "Adult ga" }]);
  assert.equal((await view("p39-staff")).coordination, null);

  // No contact, pickup note or alias appears in public views, ride records or outbox intents.
  const exposed = JSON.stringify([await view("p39-gb"), coordinator, await ride(offerId), await ride(needId), await arrangement(arrangementId), await outbox()]);
  for (const secret of ["synthetic-p39", "Synthetic pickup"]) assert.equal(exposed.includes(secret), false, secret);
  // One notice asks the driver to confirm the proposal, one tells the guardian it was confirmed.
  const intents = await outbox();
  assert.equal(intents.length, 2);
  assert.ok(intents.every((row) => row.templateKey === "rideArrangementChanged"));
  assert.deepEqual(intents.map((row) => row.audience.recipients).sort((a, b) => a[0].uid.localeCompare(b[0].uid)), [
    [{ uid: "p39-coach", accessSources: [{ kind: "team", teamId }] }],
    [{ uid: "p39-ga", accessSources: [{ kind: "household", teamId, participantId: "p39-a" }] }],
  ]);
  assert.equal(JSON.stringify(intents).includes("Adult"), false);
});

test("two confirmations for the last seat produce one winner", async () => {
  const { rideId: offerId } = await offer("p39-coach", { seats: 1 });
  const { rideId: needA } = await need("p39-ga", ["p39-a"]);
  const { rideId: needB } = await need("p39-gb", ["p39-b"]);
  const first = await consent("p39-ga", { offerId, needId: needA });
  const second = await consent("p39-gb", { offerId, needId: needB });
  const results = await Promise.allSettled([
    consent("p39-coach", { arrangementId: first.arrangementId }), consent("p39-coach", { arrangementId: second.arrangementId }),
  ]);
  assert.equal(results.filter((row) => row.status === "fulfilled").length, 1);
  const lost = results.find((row) => row.status === "rejected");
  assert.equal(lost.reason.details?.domainCode, "RIDE_SEATS_FULL");
  const stored = await ride(offerId);
  assert.equal(stored.seatsReserved, 1);
  assert.equal(stored.activeCount, 2);
  // A full offer leaves discovery for other households.
  assert.equal((await view("p39-viewer")).matches.some((row) => row.rideId === offerId), false);
});

test("duplicate confirmations replay without reserving twice", async () => {
  const { rideId: offerId } = await offer("p39-coach", { seats: 2 });
  const { rideId: needId } = await need("p39-ga", ["p39-a"]);
  const requestId = rid();
  const proposed = await consent("p39-ga", { offerId, needId }, requestId);
  assert.deepEqual(await consent("p39-ga", { offerId, needId }, requestId), proposed);
  // A second household guardian cannot open a parallel arrangement for the same request.
  await domain(consent("p39-ga2", { offerId, needId }), "RIDE_NEED_ARRANGED");
  const confirmId = rid();
  const done = await consent("p39-coach", { arrangementId: proposed.arrangementId }, confirmId);
  assert.deepEqual(await consent("p39-coach", { arrangementId: proposed.arrangementId }, confirmId), done);
  assert.equal((await consent("p39-coach", { arrangementId: proposed.arrangementId })).state, "confirmed");
  assert.equal((await consent("p39-ga", { arrangementId: proposed.arrangementId })).state, "confirmed");
  assert.equal((await ride(offerId)).seatsReserved, 1);
  assert.equal((await outbox()).length, 2);
});

test("guardian unlinking between request and confirmation blocks the ride and later contact access", async () => {
  const { rideId: offerId } = await offer("p39-coach");
  const { rideId: needId } = await need("p39-ga", ["p39-a"]);
  const { arrangementId } = await consent("p39-ga", { offerId, needId });
  const grant = db.doc(`organizations/${scope.orgId}/participants/p39-a/guardians/p39-ga`);
  await grant.update({ status: "revoked" });
  await domain(consent("p39-coach", { arrangementId }), "RIDE_PARTY_UNAVAILABLE");
  assert.equal((await ride(offerId)).seatsReserved, 0);
  await grant.update({ status: "active" });
  assert.equal((await consent("p39-coach", { arrangementId })).state, "confirmed");
  await grant.update({ "permissions.respond": false });
  await domain(contacts("p39-coach", arrangementId), "RIDE_CONTACT_UNAVAILABLE");
  // The unlinked party can still withdraw consent; it only reduces sharing.
  await grant.update({ status: "revoked" });
  assert.equal((await revoke("p39-ga", arrangementId)).state, "cancelled");
  assert.equal((await ride(offerId)).seatsReserved, 0);
});

test("unauthorized adults cannot add a child and guardians editing one request see stale revisions", async () => {
  await domain(need("p39-gb", ["p39-a"]), "RIDE_NOT_ELIGIBLE");
  await domain(need("p39-viewer", ["p39-b"]), "RIDE_NOT_ELIGIBLE");
  await deny(need("p39-child", ["p39-c"]));
  await deny(need("p39-outsider", ["p39-a"]));
  await domain(offer("p39-viewer"), "RIDE_NOT_ELIGIBLE");
  await deny(call("p39-gb", "saveRideRequest", { ...envelope(0, { kind: "need", direction: "toEvent", area: "Elm school", participantIds: ["p39-b"], discoverable: true }), orgId: "p39-other-org" }));
  await assert.rejects(offer("p39-coach", { area: "12 Main Street" }), { code: "functions/invalid-argument" });

  const { rideId } = await need("p39-ga", ["p39-a"]);
  const edit = (uid, expectedRevision, area) => call(uid, "saveRideRequest", envelope(expectedRevision, {
    rideId, kind: "need", direction: "toEvent", area, participantIds: ["p39-a"], discoverable: false,
  }));
  assert.equal((await edit("p39-ga2", 1, "Library")).revision, 2);
  await domain(edit("p39-ga", 1, "Pool"), "STALE_REVISION");
  const mine = (await view("p39-ga")).mine[0];
  assert.deepEqual([mine.revision, mine.area, mine.updatedByYou], [2, "Library", false]);
  assert.equal((await view("p39-ga2")).mine[0].updatedByYou, true);
  await deny(edit("p39-gb", 2, "Gym"));
});

test("revoking consent frees seats, deletes contacts and notifies the other party once", async () => {
  const { offerId, needId, arrangementId } = await confirmed();
  assert.equal((await revoke("p39-ga", arrangementId)).state, "cancelled");
  assert.equal((await revoke("p39-ga", arrangementId)).state, "cancelled");
  const [stored, offerRow, needRow] = [await arrangement(arrangementId), await ride(offerId), await ride(needId)];
  assert.deepEqual([stored.state, stored.cancelledBy, offerRow.seatsReserved, offerRow.activeCount, needRow.activeArrangementId], ["cancelled", "rider", 0, 0, null]);
  assert.equal((await db.collection(`events/${eventId}/rideArrangements/${arrangementId}/contacts`).get()).size, 0);
  await domain(contacts("p39-coach", arrangementId), "RIDE_CONTACT_UNAVAILABLE");
  // Re-sending an earlier consent reports the cancellation and changes nothing; the other side cannot revive it.
  assert.equal((await consent("p39-ga", { arrangementId })).state, "cancelled");
  await domain(consent("p39-ga2", { arrangementId }), "RIDE_NOT_ELIGIBLE");
  const cancelled = (await outbox()).filter((row) => row.audience.recipients[0].uid === "p39-coach");
  // The proposal notice plus one cancellation notice.
  assert.equal(cancelled.length, 2);
  assert.deepEqual(cancelled[0].audience.recipients[0].accessSources, [{ kind: "team", teamId }]);
  assert.equal(needRow.updatedBy, "p39-ga");
  // Unrelated adults cannot revoke; the designated coordinator can end an arrangement.
  const next = await consent("p39-ga", { offerId, needId });
  await deny(revoke("p39-gb", next.arrangementId));
  await deny(revoke("p39-staff", next.arrangementId));
  assert.equal((await revoke("p39-coordinator", next.arrangementId)).state, "cancelled");
  assert.equal((await ride(offerId)).activeCount, 0);
});

test("cancelling an offer ends its arrangements and a changed consent version blocks contacts", async () => {
  const { offerId, needId, arrangementId } = await confirmed();
  await policyRef().update({ consentVersion: "synthetic-consent-2" });
  await domain(contacts("p39-ga", arrangementId), "RIDE_CONTACT_UNAVAILABLE");
  const current = await ride(offerId);
  assert.equal((await call("p39-coach", "saveRideRequest", envelope(current.revision, { rideId: offerId, action: "cancel" }))).state, "cancelled");
  assert.equal((await arrangement(arrangementId)).state, "cancelled");
  assert.equal((await ride(needId)).activeArrangementId, null);
  assert.equal((await db.collection(`events/${eventId}/rideArrangements/${arrangementId}/contacts`).get()).size, 0);
});

test("a cancelled event shows arrangements cancelled and blocks new consent and contacts", async () => {
  const { offerId, arrangementId } = await confirmed();
  const { rideId: needB } = await need("p39-gb", ["p39-b"]);
  await db.doc(`events/${eventId}`).update({ status: "cancelled" });
  await domain(contacts("p39-ga", arrangementId), "RIDE_CONTACT_UNAVAILABLE");
  await domain(consent("p39-gb", { offerId, needId: needB }), "RIDE_EVENT_CANCELLED");
  await domain(offer("p39-coach"), "RIDE_EVENT_CANCELLED");
  const own = await view("p39-ga");
  assert.equal(own.arrangements[0].state, "cancelled");
  assert.deepEqual(own.matches, []);
});

test("ride documents and the transport policy stay closed to direct client reads", async () => {
  const { offerId, arrangementId } = await confirmed();
  for (const uid of ["p39-coach", "p39-ga", "p39-coordinator"]) {
    const client = clientDb(apps[uid]);
    for (const path of [`events/${eventId}/rideRequests/${offerId}`, `events/${eventId}/rideArrangements/${arrangementId}`,
      `events/${eventId}/rideArrangements/${arrangementId}/contacts/p39-coach`, `organizations/${scope.orgId}/transportPolicy/current`]) {
      await assert.rejects(getDoc(doc(client, path)), { code: "permission-denied" });
    }
  }
});

test("ride notifications carry generic copy and skip a party who lost access", async () => {
  await db.doc(`organizations/${scope.orgId}`).update({ "features.notificationInboxFake": true });
  const worker = require("./lib/notifications/worker.js");
  const { arrangementId } = await confirmed();
  await db.doc(`organizations/${scope.orgId}/participants/p39-a/guardians/p39-ga`).update({ status: "revoked" });
  assert.equal((await revoke("p39-coordinator", arrangementId)).state, "cancelled");
  for (const row of (await db.collection(`organizations/${scope.orgId}/outbox`).get()).docs) await worker.expandNotificationIntent(scope.orgId, row.id);
  const inbox = async (uid) => (await db.collection(`users/${uid}/notifications`).where("orgId", "==", scope.orgId).get()).docs.map((row) => row.data());
  const coach = await inbox("p39-coach");
  assert.equal(coach.length, 2);
  for (const row of coach) assert.deepEqual([row.title, row.body], ["Ride update", "Open Team Hangout for current details."]);
  assert.equal(JSON.stringify(coach).includes("synthetic-"), false);
  // The rider's guardian link was revoked before the cancellation intent expanded.
  assert.equal((await inbox("p39-ga")).length, 0);
  for (const uid of ["p39-coach", "p39-ga"]) await db.recursiveDelete(db.collection(`users/${uid}/notifications`));
});

test("a driver's proposal notifies the guardian who saved the request", async () => {
  const { rideId: offerId } = await offer("p39-coach");
  const { rideId: needId } = await need("p39-gb", ["p39-b"]);
  const { state } = await consent("p39-coach", { offerId, needId });
  assert.equal(state, "pending");
  assert.deepEqual((await outbox()).map((row) => row.audience.recipients), [[{ uid: "p39-gb", accessSources: [{ kind: "household", teamId, participantId: "p39-b" }] }]]);
  const invite = (await view("p39-gb")).arrangements[0];
  assert.deepEqual([invite.awaitingYou, invite.counterpartAlias, invite.participants], [true, "Adult coach", ["Synthetic p39-b"]]);
});
