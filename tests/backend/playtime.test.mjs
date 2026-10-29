import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { setTimeout as wait } from "node:timers/promises";
import { deleteApp, initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from "firebase/auth";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";
import { getFirestore as clientDb, connectFirestoreEmulator, doc, getDoc, setDoc } from "firebase/firestore";
import { projectId, requireEmulators } from "./fixtures.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { initializeApp: adminApp, deleteApp: deleteAdmin } = require("firebase-admin/app");
const { getAuth: adminAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { replayPlayLedger, ledgerTotals } = require("./lib/coaching/playLedger.js");
requireEmulators();

const users = ["p34-coach", "p34-coach2", "p34-revoked", "p34-guardian", "p34-admin", "p34-support"];
let admin;
let db;
let seq = 0;
const apps = {};
const call = async (uid, name, data) => (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const deny = (promise) => assert.rejects(promise, { code: "functions/permission-denied" });
const domain = (promise, domainCode) => assert.rejects(promise, (error) => error.details?.domainCode === domainCode);
const scope = { orgId: "p34-org", programId: "p34-program", seasonId: "p34-season", divisionId: "p34-division" };
const meta = () => ({ schemaVersion: 2, revision: 1, status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
const eventId = "p34-match";
const teamId = "p34-home";
const people = ["p34-a", "p34-b", "p34-c", "p34-d"];
const sessionPath = `events/${eventId}/playSessions/${teamId}`;
const act = (uid, expectedRevision, payload, requestId = `p34-${++seq}`) =>
  call(uid, "recordPlayAction", { requestId, orgId: scope.orgId, resourceId: eventId, expectedRevision, payload: { teamId, ...payload } });
const finalize = (uid, expectedRevision, requestId = `p34-${++seq}`) =>
  call(uid, "finalizePlaySession", { requestId, orgId: scope.orgId, resourceId: eventId, expectedRevision, payload: { teamId } });
const read = (uid) => call(uid, "getPlaySession", { eventId, teamId });
const storedActions = async () =>
  (await db.collection(`${sessionPath}/actions`).orderBy("sequence").get()).docs.map((d) => d.data());

async function saveLineup(units) {
  await db.doc(`events/${eventId}/coaching/${teamId}`).set({
    ...meta(), ...scope, eventId, teamId, sportPresetId: units.length > 1 ? "football" : "soccer", presetVersion: 1,
    units, bench: [], publication: { state: "private", sourceRevision: null, publishedAt: null, publicationRevision: 0 },
  });
}
const soccer = [{ unitId: "starting", slots: [{ slotId: "gk", participantId: "p34-a", x: 0.5, y: 0.9 }, { slotId: "st", participantId: "p34-b", x: 0.5, y: 0.1 }] }];

before(async () => {
  admin = adminApp({ projectId }, "p34-admin-app");
  db = getFirestore(admin);
  for (const uid of users) {
    const app = initializeApp({ projectId, apiKey: "demo-key" }, uid);
    apps[uid] = app;
    connectAuthEmulator(getAuth(app), "http://127.0.0.1:9099", { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), "127.0.0.1", 5001);
    connectFirestoreEmulator(clientDb(app), "127.0.0.1", 8080);
    await adminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password: "SyntheticPassword123!" }).catch(() => {});
    await db.doc(`users/${uid}`).set({ uid, appRole: uid === "p34-support" ? "superAdmin" : "user" });
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, "SyntheticPassword123!");
  }
});

after(async () => {
  await Promise.all(Object.values(apps).map((app) => deleteApp(app)));
  if (admin) await deleteAdmin(admin);
});

beforeEach(async () => {
  await db.recursiveDelete(db.doc(sessionPath));
  const batch = db.batch();
  batch.set(db.doc("organizations/p34-org"), { ...meta(), name: "Synthetic league", features: { organizationV2: true, households: true } });
  for (const [kind, name] of [["programs", scope.programId], ["seasons", scope.seasonId], ["divisions", scope.divisionId]]) {
    batch.set(db.doc(`organizations/p34-org/${kind}/${name}`), { ...meta(), ...scope, name });
  }
  batch.set(db.doc("organizations/p34-org/members/p34-admin"), { ...meta(), orgId: scope.orgId, roles: ["orgAdmin"], programIds: [] });
  for (const id of [teamId, "p34-away"]) batch.set(db.doc(`teams/${id}`), { ...meta(), ...scope, name: id });
  const member = (uid, roles, status = "active") =>
    batch.set(db.doc(`teamMembers/${teamId}_${uid}`), { ...meta(), orgId: scope.orgId, teamId, userId: uid, roles, status });
  member("p34-coach", ["coach"]);
  member("p34-coach2", ["coach"]);
  member("p34-revoked", ["coach"], "revoked");
  for (const participantId of people) {
    batch.set(db.doc(`organizations/p34-org/participants/${participantId}`), {
      ...meta(), orgId: scope.orgId, displayName: `Synthetic ${participantId.slice(4).toUpperCase()}`, kind: "youth", linkedUserId: null,
    });
    batch.set(db.doc(`teams/${teamId}/roster/${participantId}`), { ...meta(), orgId: scope.orgId, participantId });
  }
  batch.set(db.doc("organizations/p34-org/participants/p34-a/guardians/p34-guardian"), {
    ...meta(), orgId: scope.orgId, participantId: "p34-a", userId: "p34-guardian",
    permissions: { viewSchedule: true, respond: true, viewProfile: true, editProfile: false },
  });
  batch.set(db.doc(`events/${eventId}`), {
    ...meta(), ...scope, title: "Synthetic match", type: "match", teamId, teamIds: [teamId, "p34-away"], homeTeamId: teamId, awayTeamId: "p34-away",
    startsAt: Timestamp.fromDate(new Date("2026-12-20T23:00:00Z")), endsAt: Timestamp.fromDate(new Date("2026-12-21T00:30:00Z")),
    timeZone: "America/Chicago", status: "scheduled", publicationState: "published", publicationOperationId: null, deletedAt: null,
  });
  await batch.commit();
  await saveLineup(soccer);
});

test("clock transitions, substitutions and finalization replay to identical bounded totals", async () => {
  const empty = await read("p34-coach");
  assert.equal(empty.status, "notStarted");
  assert.equal(empty.lineupRevision, 1);
  await assert.rejects(act("p34-coach", 0, { kind: "start" }), { code: "functions/invalid-argument" });
  assert.equal((await act("p34-coach", 0, { kind: "start", periodCount: 2 })).state, "running");
  await wait(120);
  await act("p34-coach", 1, { kind: "substitute", unitId: "starting", outParticipantId: "p34-b", inParticipantId: "p34-c" });
  // Identical-instant substitutions while paused produce no phantom interval for p34-d.
  await act("p34-coach", 2, { kind: "pause" });
  await act("p34-coach", 3, { kind: "substitute", unitId: "starting", outParticipantId: "p34-c", inParticipantId: "p34-d" });
  await act("p34-coach", 4, { kind: "substitute", unitId: "starting", outParticipantId: "p34-d", inParticipantId: "p34-c" });
  const paused = await read("p34-coach");
  await wait(150);
  // A paused clock does not advance, and reads never write.
  const pausedAgain = await read("p34-coach");
  assert.equal(pausedAgain.elapsedMs, paused.elapsedMs);
  assert.equal(pausedAgain.revision, paused.revision);
  await act("p34-coach", 5, { kind: "resume" });
  await act("p34-coach", 6, { kind: "endPeriod" });
  await domain(act("p34-coach", 7, { kind: "pause" }), "ILLEGAL_TRANSITION");
  await act("p34-coach", 7, { kind: "start" });
  await domain(finalize("p34-coach", 8), "ILLEGAL_TRANSITION");
  await act("p34-coach", 8, { kind: "endPeriod" });
  const ended = await read("p34-coach");
  assert.equal(ended.status, "ended");
  const done = await finalize("p34-coach", 9);
  assert.equal(done.state, "finalized");
  const session = (await db.doc(sessionPath).get()).data();
  const actions = await storedActions();
  assert.deepEqual(actions.map((a) => a.action.kind), ["start", "substitute", "pause", "substitute", "substitute", "resume", "endPeriod", "start", "endPeriod", "finalize"]);
  assert.ok(actions.every((a) => a.actorUid === "p34-coach" && a.operationId && a.sequence === a.action.sequence));
  const replayed = ledgerTotals(replayPlayLedger(actions.map((a) => a.action)));
  assert.deepEqual(replayed, session.finalTotals);
  assert.deepEqual(ended.totals.map((t) => t.participantId).sort(), ["p34-a", "p34-b", "p34-c"]);
  assert.equal(session.finalTotals["p34-a"], session.durationMs);
  assert.equal(session.finalTotals["p34-b"] + session.finalTotals["p34-c"], session.durationMs);
  for (const total of Object.values(session.finalTotals)) assert.ok(total >= 0 && total <= session.durationMs);
  assert.equal(session.anchorAt, null);
  await domain(act("p34-coach", 10, { kind: "pause" }), "SESSION_FINALIZED");
  await domain(finalize("p34-coach", 10), "SESSION_FINALIZED");
});

test("a running clock estimate advances from its anchor without timer writes", async () => {
  await act("p34-coach", 0, { kind: "start", periodCount: 1 });
  const first = await read("p34-coach");
  await wait(300);
  const second = await read("p34-coach");
  assert.equal(second.revision, first.revision);
  assert.ok(second.elapsedMs >= first.elapsedMs + 250, `${second.elapsedMs} vs ${first.elapsedMs}`);
  assert.equal((await storedActions()).length, 1);
});

test("duplicate commands replay once and simultaneous coaches cannot both apply a revision", async () => {
  await act("p34-coach", 0, { kind: "start", periodCount: 1 });
  const sub = { kind: "substitute", unitId: "starting", outParticipantId: "p34-b", inParticipantId: "p34-c" };
  const first = await act("p34-coach", 1, sub, "p34-dup");
  assert.deepEqual(await act("p34-coach", 1, sub, "p34-dup"), first);
  await domain(act("p34-coach", 1, { kind: "pause" }, "p34-dup"), "REQUEST_ID_REUSED");
  const outcomes = await Promise.allSettled([act("p34-coach", 2, { kind: "pause" }), act("p34-coach2", 2, { kind: "endPeriod" })]);
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  assert.equal(outcomes.find((o) => o.status === "rejected").reason.details.domainCode, "STALE_REVISION");
  assert.equal((await storedActions()).length, 3);
});

test("closed-period corrections recompute totals, keep raw actions and report affected participants", async () => {
  await act("p34-coach", 0, { kind: "start", periodCount: 2 });
  await wait(150);
  await act("p34-coach", 1, { kind: "substitute", unitId: "starting", outParticipantId: "p34-b", inParticipantId: "p34-c" });
  await wait(150);
  await act("p34-coach", 2, { kind: "endPeriod" });
  const before = await storedActions();
  const original = before[1].action;
  const correction = { kind: "correct", targetSequence: 2, atElapsedMs: 50, outParticipantId: "p34-b", inParticipantId: "p34-d", reason: "Scorer sheet shows the change earlier" };
  await assert.rejects(act("p34-coach", 3, { ...correction, reason: " " }), { code: "functions/invalid-argument" });
  await domain(act("p34-coach", 3, { ...correction, inParticipantId: "p34-ghost" }), "PARTICIPANT_UNAVAILABLE");
  await domain(act("p34-coach", 3, { ...correction, targetSequence: 1 }), "INVALID_ACTION");
  const corrected = await act("p34-coach", 3, correction);
  assert.deepEqual(corrected.affectedParticipantIds, ["p34-b", "p34-c", "p34-d"]);
  const after = await storedActions();
  assert.deepEqual(after[1].action, original);
  assert.equal(after[3].action.reason, correction.reason);
  const state = await read("p34-coach");
  const totals = Object.fromEntries(state.totals.map((t) => [t.participantId, t.ms]));
  assert.equal(totals["p34-b"], 50);
  assert.equal(totals["p34-c"], undefined);
  assert.equal(totals["p34-d"], state.elapsedMs - 50);
  assert.deepEqual(state.units, [{ unitId: "starting", participantIds: ["p34-a", "p34-d"] }]);
  // A correction that contradicts later history is rejected.
  await act("p34-coach", 4, { kind: "start" });
  await act("p34-coach", 5, { kind: "substitute", unitId: "starting", outParticipantId: "p34-d", inParticipantId: "p34-b" });
  await domain(act("p34-coach", 6, { ...correction, inParticipantId: "p34-c" }), "CORRECTION_CONFLICT");
});

test("football unit switches count union time once", async () => {
  await saveLineup([
    { unitId: "offense", slots: [{ slotId: "qb", participantId: "p34-a", x: 0.5, y: 0.5 }, { slotId: "rb", participantId: "p34-b", x: 0.5, y: 0.6 }] },
    { unitId: "defense", slots: [{ slotId: "mlb", participantId: "p34-a", x: 0.5, y: 0.5 }, { slotId: "fs", participantId: "p34-c", x: 0.5, y: 0.2 }] },
    { unitId: "specialTeams", slots: [] },
  ]);
  await act("p34-coach", 0, { kind: "start", periodCount: 1 });
  await wait(100);
  await act("p34-coach", 1, { kind: "switchUnit", unitId: "defense" });
  await domain(act("p34-coach", 2, { kind: "switchUnit", unitId: "defense" }), "ILLEGAL_TRANSITION");
  await wait(100);
  await act("p34-coach", 2, { kind: "endPeriod" });
  const state = await read("p34-coach");
  const totals = Object.fromEntries(state.totals.map((t) => [t.participantId, t.ms]));
  assert.equal(totals["p34-a"], state.elapsedMs);
  assert.equal(totals["p34-b"] + totals["p34-c"], state.elapsedMs);
});

test("only active assigned coaches reach playing time and the ledger is callable-only", async () => {
  await domain(act("p34-coach", 0, { kind: "substitute", unitId: "starting", outParticipantId: "p34-b", inParticipantId: "p34-c" }), "ILLEGAL_TRANSITION");
  await act("p34-coach", 0, { kind: "start", periodCount: 1 });
  await db.doc(`teams/${teamId}/roster/p34-c`).update({ status: "removed" });
  const revision = 1;
  await domain(act("p34-coach", revision, { kind: "substitute", unitId: "starting", outParticipantId: "p34-b", inParticipantId: "p34-c" }), "PARTICIPANT_UNAVAILABLE");
  for (const uid of ["p34-revoked", "p34-guardian", "p34-admin", "p34-support"]) {
    await deny(read(uid));
    await deny(act(uid, revision, { kind: "pause" }));
    await deny(finalize(uid, revision));
  }
  await db.doc(`teamMembers/${teamId}_p34-coach2`).update({ status: "revoked" });
  await deny(act("p34-coach2", revision, { kind: "pause" }));
  const [action] = await storedActions();
  for (const uid of ["p34-coach", "p34-guardian", "p34-support"]) {
    const client = clientDb(apps[uid]);
    for (const path of [sessionPath, `${sessionPath}/actions/${action.operationId}`]) {
      await assert.rejects(getDoc(doc(client, path)), { code: "permission-denied" });
      await assert.rejects(setDoc(doc(client, path), { tampered: true }), { code: "permission-denied" });
    }
  }
});

test("starting requires a saved lineup with every participant still rostered", async () => {
  await db.doc(`teams/${teamId}/roster/p34-b`).update({ status: "removed" });
  await domain(act("p34-coach", 0, { kind: "start", periodCount: 1 }), "PARTICIPANT_UNAVAILABLE");
  await db.doc(`events/${eventId}/coaching/${teamId}`).delete();
  await domain(act("p34-coach", 0, { kind: "start", periodCount: 1 }), "LINEUP_NOT_SAVED");
  await domain(finalize("p34-coach", 0), "SESSION_NOT_STARTED");
  assert.equal((await storedActions()).length, 0);
});
