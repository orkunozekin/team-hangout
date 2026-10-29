import { after, before, test } from "node:test";
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

const users = ["p36-manager", "p36-other-staff", "p36-coach", "p36-player", "p36-revoked", "p36-outsider", "p36-foreign"];
const scope = { orgId: "p36-org", programId: "p36-program", seasonId: "p36-season", divisionId: "p36-division" };
const teams = ["p36-a", "p36-b", "p36-c", "p36-d"];
const past = Timestamp.fromDate(new Date("2026-03-01T18:00:00Z"));
/** Synthetic policy for tests only. A pilot manager has not approved real league rules (external gate). */
const rules = {
  rulesSchemaVersion: 1,
  points: { win: 3, draw: 1, loss: 0, forfeitWin: 3, forfeitLoss: 0 },
  allowDraws: true,
  forfeitScore: { winner: 3, loser: 0 },
  countedOutcomes: ["played", "forfeit"],
  tieBreakers: ["tablePoints", "headToHeadPoints", "scoreDifferential", "scoresFor", "wins"],
  scoreDifferentialCap: null,
  knockoutDeciders: [],
};
// Hand-calculated fixture: A, B and C tie on 6 points and 3 head-to-head points; differential leaves A and B, then
// scores for ranks B above A without reapplying head-to-head (where A beat B).
const fixture = [["m1", "p36-a", 2, "p36-b", 0], ["m2", "p36-b", 1, "p36-c", 0], ["m3", "p36-c", 1, "p36-a", 0],
  ["m4", "p36-a", 1, "p36-d", 0], ["m5", "p36-b", 3, "p36-d", 0], ["m6", "p36-c", 1, "p36-d", 0]];

let admin;
let db;
let worker;
let seq = 0;
const apps = {};
const call = async (uid, name, data) => (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const deny = (promise) => assert.rejects(promise, { code: "functions/permission-denied" });
const domain = (promise, domainCode) => assert.rejects(promise, (error) => {
  assert.equal(error.details?.domainCode, domainCode, error.message);
  return true;
});
const meta = () => ({ schemaVersion: 2, revision: 1, status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
const path = (competitionId) => `organizations/${scope.orgId}/competitions/${competitionId}`;
const played = (homeScore, awayScore) => ({ outcome: "played", homeScore, awayScore, forfeitingTeamId: null, winnerTeamId: null, decider: null });
const voided = { outcome: "void", homeScore: null, awayScore: null, forfeitingTeamId: null, winnerTeamId: null, decider: null };
const envelope = (competitionId, expectedRevision, payload) => ({ requestId: `p36-${++seq}`, orgId: scope.orgId, resourceId: competitionId, expectedRevision, payload });
const order = (view) => view.rows.map((row) => [row.teamId, row.rank, row.points, row.sharedRank]);
const generations = async (competitionId) => (await db.collection(`${path(competitionId)}/generations`).get()).docs.map((d) => d.data());

async function settled(competitionId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = (await db.doc(path(competitionId)).get()).data();
    if (worker.standingsStatus(row) === "current") return row;
    if (Date.now() > deadline) throw new Error(`Standings for ${competitionId} did not settle.`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function league(competitionId, results = fixture) {
  await call("p36-manager", "saveCompetitionRules", envelope(competitionId, 0, {
    programId: scope.programId, seasonId: scope.seasonId, divisionId: scope.divisionId, name: `Synthetic ${competitionId}`,
    format: "league", teamIds: teams, rules, confirm: true,
  }));
  const batch = db.batch();
  for (const [eventId, home, , away] of results) {
    batch.set(db.doc(`events/${competitionId}-${eventId}`), {
      ...meta(), ...scope, title: `Synthetic ${eventId}`, type: "match", teamId: home, teamIds: [home, away], homeTeamId: home, awayTeamId: away,
      startsAt: past, endsAt: past, timeZone: "America/Chicago", status: "scheduled", publicationState: "published", publicationOperationId: null, deletedAt: null,
    });
  }
  await batch.commit();
  for (const [eventId, , homeScore, , awayScore] of results) {
    await call("p36-manager", "finalizeResult", envelope(competitionId, 0, { eventId: `${competitionId}-${eventId}`, result: played(homeScore, awayScore) }));
  }
}

const correct = async (competitionId, eventId, result, reason = "Referee sheet corrected") => {
  const ref = db.doc(`${path(competitionId)}/results/${competitionId}-${eventId}`);
  const revision = (await ref.get()).data().revision;
  return call("p36-manager", "correctResult", envelope(competitionId, revision, { eventId: `${competitionId}-${eventId}`, result, reason }));
};

before(async () => {
  admin = adminApp({ projectId });
  db = getFirestore(admin);
  worker = require("./lib/competition/generations.js");
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
  await db.recursiveDelete(db.collection(`organizations/${scope.orgId}/competitions`));
  const batch = db.batch();
  batch.set(db.doc(`organizations/${scope.orgId}`), { ...meta(), name: "Synthetic league", features: { organizationV2: true, households: true } });
  batch.set(db.doc("organizations/p36-foreign-org"), { ...meta(), name: "Foreign league", features: { organizationV2: true } });
  for (const [kind, name] of [["programs", scope.programId], ["programs", "p36-program-2"], ["seasons", scope.seasonId], ["divisions", scope.divisionId]]) {
    batch.set(db.doc(`organizations/${scope.orgId}/${kind}/${name}`), { ...meta(), ...scope, ...(name === "p36-program-2" ? { programId: name } : {}), name });
  }
  batch.set(db.doc(`organizations/${scope.orgId}/members/p36-manager`), { ...meta(), orgId: scope.orgId, roles: ["orgAdmin"], programIds: [] });
  batch.set(db.doc(`organizations/${scope.orgId}/members/p36-other-staff`), { ...meta(), orgId: scope.orgId, roles: ["programStaff"], programIds: ["p36-program-2"] });
  batch.set(db.doc("organizations/p36-foreign-org/members/p36-foreign"), { ...meta(), orgId: "p36-foreign-org", roles: ["orgAdmin"], programIds: [] });
  for (const id of teams) batch.set(db.doc(`teams/${id}`), { ...meta(), ...scope, name: `Team ${id.slice(-1).toUpperCase()}` });
  const member = (uid, roles, status = "active", teamId = "p36-a") =>
    batch.set(db.doc(`teamMembers/${teamId}_${uid}`), { ...meta(), orgId: scope.orgId, teamId, userId: uid, roles, status });
  member("p36-coach", ["coach"]);
  member("p36-player", ["player"]);
  member("p36-revoked", ["player"], "revoked");
  batch.set(db.doc("events/p36-view"), {
    ...meta(), ...scope, title: "Synthetic viewer match", type: "match", teamId: "p36-a", teamIds: ["p36-a", "p36-b"], homeTeamId: "p36-a", awayTeamId: "p36-b",
    startsAt: past, endsAt: past, timeZone: "America/Chicago", status: "scheduled", publicationState: "published", publicationOperationId: null, deletedAt: null,
  });
  await batch.commit();
});

after(async () => {
  await Promise.all(Object.values(apps).map((app) => deleteApp(app)));
  if (admin) await deleteAdmin(admin);
});

test("completed table matches the hand calculation and only team viewers and scoped staff can read it", async () => {
  await league("p36-table");
  const competition = await settled("p36-table");
  const view = await call("p36-manager", "getStandings", { orgId: scope.orgId, competitionId: "p36-table" });
  assert.equal(view.status, "current");
  assert.deepEqual(order(view), [["p36-b", 1, 6, false], ["p36-a", 2, 6, false], ["p36-c", 3, 6, false], ["p36-d", 4, 0, false]]);
  assert.deepEqual(view.rows.map((row) => row.decidedBy), ["scoresFor", "scoresFor", "scoreDifferential", "tablePoints"]);
  assert.deepEqual([view.generation.sourceRevision, view.generation.rulesVersion, view.generation.countedResults, view.generation.active], [6, 1, 6, true]);
  assert.equal(view.rows[0].teamName, "Team B");

  // A duplicate invocation finds the active generation current and builds nothing.
  const before = (await generations("p36-table")).length;
  assert.equal((await worker.buildStandings(scope.orgId, "p36-table")).state, "current");
  assert.equal((await generations("p36-table")).length, before);
  const active = (await db.doc(`${path("p36-table")}/generations/${competition.activeGeneration.generationId}`).get()).data();
  assert.equal(active.state, "complete");
  assert.match(active.inputDigest, /^[0-9a-f]{64}$/);

  const family = await call("p36-player", "getEventStandings", { eventId: "p36-view", teamId: "p36-a" });
  assert.deepEqual(family.competitions.map((row) => row.competitionId), ["p36-table"]);
  assert.deepEqual(order(family.standings), order(view));
  assert.equal(JSON.stringify(family).includes("finalizedBy"), false);
  await call("p36-coach", "getEventStandings", { eventId: "p36-view", teamId: "p36-a" });
  for (const uid of ["p36-revoked", "p36-outsider", "p36-foreign"]) await deny(call(uid, "getEventStandings", { eventId: "p36-view", teamId: "p36-a" }));
  for (const uid of ["p36-other-staff", "p36-player", "p36-foreign"]) await deny(call(uid, "getStandings", { orgId: scope.orgId, competitionId: "p36-table" }));
  await assert.rejects(call("p36-player", "getEventStandings", { eventId: "p36-view", teamId: "p36-a", generationId: active.generationId }), { code: "functions/invalid-argument" });
  await assert.rejects(getDoc(doc(clientDb(apps["p36-manager"]), `${path("p36-table")}/generations/${active.generationId}`)), { code: "permission-denied" });
});

test("a correction racing a rebuild is discarded, duplicate builds converge on one active complete generation", async () => {
  await league("p36-race");
  await settled("p36-race");
  let raced = null;
  for (let attempt = 0; attempt < 3 && !raced?.discarded; attempt++) {
    // First correction: A 0-1 B. Then, while this build is between reading results and activation, void C 1-0 D.
    await correct("p36-race", attempt === 0 ? "m1" : "m4", attempt === 0 ? played(0, 1) : played(1, 0 + attempt));
    let fired = false;
    raced = await worker.buildStandings(scope.orgId, "p36-race", {
      beforeActivate: async () => {
        if (fired) return;
        fired = true;
        if (attempt === 0) await correct("p36-race", "m6", voided); else await correct("p36-race", "m5", played(3, attempt));
      },
    });
  }
  assert.ok(raced.discarded >= 1, `expected a discarded build, got ${JSON.stringify(raced)}`);
  await Promise.all([1, 2, 3].map(() => worker.buildStandings(scope.orgId, "p36-race")));
  const competition = await settled("p36-race");
  const view = await call("p36-manager", "getStandings", { orgId: scope.orgId, competitionId: "p36-race" });
  assert.equal(view.generation.sourceRevision, competition.sourceRevision);
  // Hand calculation after both corrections: B 9; A and C 3 with C ahead on head-to-head (C beat A); D 0.
  if (competition.sourceRevision === 8) {
    assert.deepEqual(order(view), [["p36-b", 1, 9, false], ["p36-c", 2, 3, false], ["p36-a", 3, 3, false], ["p36-d", 4, 0, false]]);
    assert.deepEqual(view.rows.map((row) => row.decidedBy), ["tablePoints", "headToHeadPoints", "headToHeadPoints", "tablePoints"]);
  }
  // Wait for straggling trigger invocations, then check generation invariants.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const rows = await generations("p36-race");
  const complete = rows.filter((row) => row.state === "complete");
  const perRevision = new Map();
  for (const row of complete) perRevision.set(row.sourceRevision, (perRevision.get(row.sourceRevision) ?? 0) + 1);
  assert.ok([...perRevision.values()].every((count) => count === 1), "one complete generation per source");
  assert.ok(complete.length <= 3, "retention keeps at most three complete generations");
  assert.equal(rows.some((row) => row.state === "building"), false);
  for (const row of rows.filter((row) => row.state !== "complete")) {
    assert.equal((await db.collection(`${path("p36-race")}/generations/${row.generationId}/rows`).count().get()).data().count, 0, `${row.state} rows removed`);
  }
  for (const row of complete) {
    assert.equal((await db.collection(`${path("p36-race")}/generations/${row.generationId}/rows`).count().get()).data().count, 4);
  }
  assert.equal(competition.standingsPendingSince, null);
});

test("status shows updating, then stale, never a mixed table", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  const base = { schemaVersion: 2, activeRules: rules, activeRulesVersion: 1, teamIds: teams, sourceRevision: 3, createdAt: Timestamp.fromMillis(now - 1e6) };
  const key = worker.standingsKey(base);
  assert.equal(worker.standingsStatus({ ...base, activeGeneration: { ...key, generationId: "g" }, standingsPendingSince: null }, now), "current");
  const pending = { ...base, activeGeneration: { ...key, sourceRevision: 2, generationId: "g" } };
  assert.equal(worker.standingsStatus({ ...pending, standingsPendingSince: Timestamp.fromMillis(now - 60_000) }, now), "updating");
  assert.equal(worker.standingsStatus({ ...pending, standingsPendingSince: Timestamp.fromMillis(now - worker.STALE_AFTER_MS - 1) }, now), "stale");
  assert.equal(worker.standingsStatus({ ...base, activeRules: null, activeRulesVersion: null }, now), "unconfirmed");
  // A recreated competition that restarts revisions never matches an older generation.
  assert.notDeepEqual(worker.standingsKey({ ...base, createdAt: Timestamp.fromMillis(now) }), key);
});

test("capped-size load probe: 256 teams and 4,096 final results, pinned paging and reconciliation", async () => {
  const competitionId = "p36-probe";
  const teamIds = Array.from({ length: 256 }, (_, i) => `p36-probe-${String(i).padStart(3, "0")}`);
  const ref = db.doc(path(competitionId));
  let batch = db.batch();
  let pending = 0;
  const flush = async (force = false) => {
    if (pending >= 450 || (force && pending)) { await batch.commit(); batch = db.batch(); pending = 0; }
  };
  for (const teamId of teamIds) { batch.set(db.doc(`teams/${teamId}`), { ...meta(), ...scope, name: `Probe ${teamId.slice(-3)}` }); pending++; await flush(); }
  for (let i = 0; i < 4096; i++) {
    const home = teamIds[i % 256];
    const away = teamIds[(i % 256 + 1 + Math.floor(i / 256)) % 256];
    const homeScore = (i * 7) % 5;
    const awayScore = (i * 3) % 4;
    batch.set(ref.collection("results").doc(`probe-${String(i).padStart(4, "0")}`), {
      schemaVersion: 2, orgId: scope.orgId, competitionId, eventId: `probe-${i}`, homeTeamId: home, awayTeamId: away, status: "final", revision: 1,
      final: { outcome: "played", homeScore, awayScore, forfeitingTeamId: null, winnerTeamId: homeScore > awayScore ? home : homeScore < awayScore ? away : null, decider: null, appliedRulesVersion: 1 },
    });
    pending++;
    await flush();
  }
  await flush(true);
  const now = Timestamp.now();
  // Written last so the trigger sees every result. The pending marker is old so reconciliation also picks it up.
  await ref.set({
    schemaVersion: 2, orgId: scope.orgId, competitionId, ...scope, name: "Synthetic probe", format: "league", teamIds, state: "active",
    revision: 1, sourceRevision: 4096, finalResultCount: 4096, activeRules: { ...rules, scoreDifferentialCap: 3 }, activeRulesVersion: 1, draftRules: rules,
    createdAt: now, sourceUpdatedAt: now, standingsPendingSince: Timestamp.fromMillis(now.toMillis() - 120_000),
  });
  const reconciled = await worker.reconcilePendingStandings(25, 60_000);
  assert.ok(reconciled.scanned >= 1 && reconciled.failed === 0, JSON.stringify(reconciled));
  const competition = await settled(competitionId, 120000);
  const generation = (await db.doc(`${path(competitionId)}/generations/${competition.activeGeneration.generationId}`).get()).data();
  assert.deepEqual([generation.rowCount, generation.countedResults, generation.stats.resultReads, generation.stats.teamReads], [256, 4096, 4096, 256]);
  console.log(`standings load probe: ${JSON.stringify(generation.stats)}`);

  const first = await call("p36-manager", "getStandings", { orgId: scope.orgId, competitionId });
  assert.equal(first.rows.length, 50);
  assert.ok(first.nextCursor);
  // A new activation while paging: the pinned generation keeps serving the same table, never a mix.
  await ref.update({ sourceRevision: 4097, sourceUpdatedAt: Timestamp.now(), standingsPendingSince: Timestamp.now() });
  await settled(competitionId, 120000);
  const seen = [...first.rows];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await call("p36-manager", "getStandings", { orgId: scope.orgId, competitionId, generationId: first.generation.generationId, cursor });
    assert.equal(page.generation.generationId, first.generation.generationId);
    assert.equal(page.generation.active, false);
    seen.push(...page.rows);
    cursor = page.nextCursor;
  }
  assert.deepEqual(seen.map((row) => row.position), Array.from({ length: 256 }, (_, i) => i + 1));
  assert.equal(new Set(seen.map((row) => row.teamId)).size, 256);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].rank >= seen[i - 1].rank);
  await domain(call("p36-manager", "getStandings", { orgId: scope.orgId, competitionId, generationId: "p36-unknown", cursor: "0050" }), "STANDINGS_CHANGED");
});

test("abandoned builds are swept on schedule without touching complete or recent generations", async () => {
  await league("p36-sweep", fixture.slice(0, 2));
  const competition = await settled("p36-sweep");
  const generationsRef = db.collection(`${path("p36-sweep")}/generations`);
  const old = Timestamp.fromMillis(Date.now() - 20 * 60 * 1000);
  const stuck = generationsRef.doc("p36-stuck");
  const recent = generationsRef.doc("p36-recent");
  await stuck.set({ schemaVersion: 2, state: "building", startedAt: old });
  await stuck.collection("rows").doc("0001").set({ position: 1 });
  await recent.set({ schemaVersion: 2, state: "building", startedAt: Timestamp.now() });
  await recent.collection("rows").doc("0001").set({ position: 1 });
  // Make the active generation look old too; only building generations are swept.
  const activeRef = generationsRef.doc(competition.activeGeneration.generationId);
  await activeRef.update({ startedAt: old });
  assert.ok(await worker.sweepAbandonedBuilds() >= 1);
  assert.equal((await stuck.get()).data().state, "failed");
  assert.equal((await stuck.collection("rows").count().get()).data().count, 0);
  assert.equal((await recent.get()).data().state, "building");
  assert.equal((await recent.collection("rows").count().get()).data().count, 1);
  assert.equal((await activeRef.get()).data().state, "complete");
  assert.equal((await activeRef.collection("rows").count().get()).data().count, 4);
  const view = await call("p36-manager", "getStandings", { orgId: scope.orgId, competitionId: "p36-sweep" });
  assert.equal(view.status, "current");
  await recent.update({ state: "failed" });
});
