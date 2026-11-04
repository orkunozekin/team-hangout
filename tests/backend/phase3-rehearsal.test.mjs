import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { deleteApp, initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from "firebase/auth";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";
import { projectId, requireEmulators } from "./fixtures.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { initializeApp: adminApp, deleteApp: deleteAdmin } = require("firebase-admin/app");
const { getAuth: adminAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { replayPlayLedger, ledgerTotals } = require("./lib/coaching/playLedger.js");
requireEmulators();

// Synthetic multi-organization season rehearsal for Phase 3 Step 14. Every record is invented test data.
const hub = `http://${process.env.FIREBASE_EMULATOR_HUB ?? "127.0.0.1:4400"}`;
const users = ["p314-manager", "p314-coach", "p314-guardian", "p314-foreign"];
const orgId = "p314-org";
const foreignOrg = "p314-foreign-org";
const scope = { orgId, programId: "p314-program", seasonId: "p314-season", divisionId: "p314-division" };
const [A, B, C, D] = ["p314-a", "p314-b", "p314-c", "p314-d"];
const teams = [A, B, C, D];
const people = ["p314-p1", "p314-p2", "p314-p3", "p314-p4"];
const kickoff = (day) => Timestamp.fromDate(new Date(`2026-03-${String(day).padStart(2, "0")}T18:00:00Z`));
/** Synthetic policies for tests only; a pilot manager has not approved real league rules (external gate). */
const leagueRules = {
  rulesSchemaVersion: 1, points: { win: 3, draw: 1, loss: 0, forfeitWin: 3, forfeitLoss: 0 }, allowDraws: true, forfeitScore: { winner: 3, loser: 0 },
  countedOutcomes: ["played", "forfeit"], tieBreakers: ["tablePoints", "scoreDifferential", "scoresFor", "wins"], scoreDifferentialCap: null, knockoutDeciders: [],
};
const knockoutRules = { ...leagueRules, allowDraws: false, points: { ...leagueRules.points, draw: 0 }, knockoutDeciders: ["penalties"] };
const played = (homeScore, awayScore) => ({ outcome: "played", homeScore, awayScore, forfeitingTeamId: null, winnerTeamId: null, decider: null });

let admin;
let db;
let seq = 0;
const apps = {};
const timings = {};
const call = async (uid, name, data) => (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const deny = (promise) => assert.rejects(promise, { code: "functions/permission-denied" });
const domain = (promise, domainCode) => assert.rejects(promise, (error) => {
  assert.equal(error.details?.domainCode, domainCode, error.message);
  return true;
});
const meta = () => ({ schemaVersion: 2, revision: 1, status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
const envelope = (resourceId, expectedRevision, payload) => ({ requestId: `p314-${++seq}`, orgId, resourceId, expectedRevision, payload });
const competitionPath = (id) => `organizations/${orgId}/competitions/${id}`;
const triggers = async (enabled) => {
  const response = await fetch(`${hub}/functions/${enabled ? "enable" : "disable"}BackgroundTriggers`, { method: "PUT" });
  assert.equal(response.ok, true, `Could not ${enabled ? "enable" : "disable"} background triggers`);
};
async function timed(label, work) {
  const started = performance.now();
  const value = await work();
  timings[label] = Math.round(performance.now() - started);
  return value;
}
const matchDoc = (home, away, day, extra = {}) => ({
  ...meta(), ...scope, title: "Synthetic match", type: "match", teamId: home, teamIds: [home, away], homeTeamId: home, awayTeamId: away,
  startsAt: kickoff(day), endsAt: kickoff(day), timeZone: "America/Chicago", status: "completed", publicationState: "published",
  publicationOperationId: null, deletedAt: null, scheduleVersion: 1, ...extra,
});
const resultRevision = async (competitionId, eventId) => (await db.doc(`${competitionPath(competitionId)}/results/${eventId}`).get()).data()?.revision ?? 0;
const finalize = async (competitionId, eventId, result) =>
  call("p314-manager", "finalizeResult", envelope(competitionId, await resultRevision(competitionId, eventId), { eventId, result }));

let standings;
let reports;
let rollover;

before(async () => {
  admin = adminApp({ projectId });
  db = getFirestore(admin);
  standings = require("./lib/competition/generations.js");
  reports = require("./lib/reports/runs.js");
  rollover = require("./lib/seasons/rollover.js");
  for (const uid of users) {
    const app = initializeApp({ projectId, apiKey: "demo-key" }, uid);
    apps[uid] = app;
    connectAuthEmulator(getAuth(app), "http://127.0.0.1:9099", { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), "127.0.0.1", 5001);
    await adminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password: "SyntheticPassword123!" }).catch(() => {});
    await db.doc(`users/${uid}`).set({ uid, appRole: "user" });
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, "SyntheticPassword123!");
  }
  for (const path of [`organizations/${orgId}/competitions`, `organizations/${orgId}/reportRuns`, `organizations/${orgId}/rolloverJobs`]) {
    await db.recursiveDelete(db.collection(path));
  }
  const batch = db.batch();
  const features = { organizationV2: true, households: true, reports: true, rollover: true };
  batch.set(db.doc(`organizations/${orgId}`), { ...meta(), name: "Synthetic league", timeZone: "America/Chicago", features });
  batch.set(db.doc(`organizations/${foreignOrg}`), { ...meta(), name: "Foreign league", timeZone: "UTC", features });
  batch.set(db.doc(`organizations/${orgId}/programs/${scope.programId}`), { ...meta(), orgId, name: "Youth Soccer", sportCode: "soccer" });
  batch.set(db.doc(`organizations/${orgId}/seasons/${scope.seasonId}`), { ...meta(), orgId, programId: scope.programId, name: "Spring 2026", startsOn: "2026-03-01", endsOn: "2026-05-31" });
  batch.set(db.doc(`organizations/${orgId}/divisions/${scope.divisionId}`), { ...meta(), orgId, programId: scope.programId, seasonId: scope.seasonId, name: "U10", ageBandLabel: null });
  batch.set(db.doc(`organizations/${orgId}/members/p314-manager`), { ...meta(), orgId, roles: ["orgAdmin"], programIds: [] });
  batch.set(db.doc(`organizations/${foreignOrg}/members/p314-foreign`), { ...meta(), orgId: foreignOrg, roles: ["orgAdmin"], programIds: [] });
  batch.set(db.doc("teams/p314-foreign-team"), { ...meta(), orgId: foreignOrg, programId: "p314-foreign-program", seasonId: "p314-foreign-season", divisionId: "p314-foreign-division", name: "Foreign team" });
  for (const id of teams) batch.set(db.doc(`teams/${id}`), { ...meta(), ...scope, name: `Team ${id.slice(-1).toUpperCase()}`, sport: "soccer", inviteCode: null });
  batch.set(db.doc(`teamMembers/${A}_p314-coach`), { ...meta(), orgId, teamId: A, userId: "p314-coach", roles: ["coach"] });
  for (const participantId of people) {
    batch.set(db.doc(`organizations/${orgId}/participants/${participantId}`), { ...meta(), orgId, displayName: `Synthetic ${participantId.slice(-2)}`, kind: "youth", linkedUserId: null });
    batch.set(db.doc(`teams/${A}/roster/${participantId}`), { ...meta(), orgId, teamId: A, participantId });
  }
  batch.set(db.doc(`organizations/${orgId}/participants/p314-p1/guardians/p314-guardian`), {
    ...meta(), orgId, participantId: "p314-p1", userId: "p314-guardian", permissions: { viewSchedule: true, respond: true, viewProfile: true, editProfile: false },
  });
  // League round: A beats B, C beats D, A beats C, B draws D. Match m1 carries the attendance snapshot.
  const league = [["p314-m1", A, B, 1], ["p314-m2", C, D, 2], ["p314-m3", A, C, 8], ["p314-m4", B, D, 9]];
  for (const [eventId, home, away, day] of league) {
    batch.set(db.doc(`events/${eventId}`), matchDoc(home, away, day, eventId === "p314-m1"
      ? { rosterSnapshot: { schemaVersion: 2, capturedRevision: 2, scheduleVersion: 1, participantCount: 4, eligibleCount: 4 } } : {}));
  }
  const attendance = { "p314-p1": "present", "p314-p2": "present", "p314-p3": "late", "p314-p4": "absent" };
  for (const [participantId, status] of Object.entries(attendance)) {
    batch.set(db.doc(`events/p314-m1/rosterSnapshots/${participantId}`), {
      schemaVersion: 2, orgId, eventId: "p314-m1", participantId, displayName: `Synthetic ${participantId.slice(-2)}`, teamIds: [A], capturedRevision: 2,
      enrollments: [{ teamId: A, eligible: true, status: "active" }], eligible: true,
    });
    batch.set(db.doc(`events/p314-m1/attendance/${participantId}`), { schemaVersion: 2, orgId, eventId: "p314-m1", participantId, status, scheduleVersion: 1, revision: 1, teamId: A });
  }
  await batch.commit();
  // Workers run in-process so each stage is timed and deterministic; trigger delivery is covered by the step suites.
  await triggers(false);
});

after(async () => {
  await triggers(true).catch(() => {});
  console.log(`phase 3 rehearsal timings (emulator ms, not production latency): ${JSON.stringify(timings)}`);
  await Promise.all(Object.values(apps).map((app) => deleteApp(app)));
  if (admin) await deleteAdmin(admin);
});

test("rehearsal: lineup, timed substitutions and a correction replay to one private ledger", async () => {
  const lineup = await timed("saveLineup", () => call("p314-coach", "saveLineup", envelope("p314-m1", 0, {
    teamId: A, sportPresetId: "soccer", note: "Synthetic private coaching note",
    units: [{ unitId: "starting", slots: [{ slotId: "gk", participantId: "p314-p1", x: 0.5, y: 0.9 }, { slotId: "st", participantId: "p314-p2", x: 0.5, y: 0.1 }] }],
    bench: ["p314-p3", "p314-p4"],
  })));
  assert.equal(lineup.revision, 1);
  const reloaded = await call("p314-coach", "getLineup", { eventId: "p314-m1", teamId: A });
  assert.deepEqual([reloaded.bench, reloaded.units[0].slots.map((slot) => slot.participantId)], [["p314-p3", "p314-p4"], ["p314-p1", "p314-p2"]]);
  await deny(call("p314-guardian", "getLineup", { eventId: "p314-m1", teamId: A }));
  await deny(call("p314-foreign", "getLineup", { eventId: "p314-m1", teamId: A }));
  assert.deepEqual(await call("p314-guardian", "getLineupView", { eventId: "p314-m1", teamId: A, participantId: "p314-p1" }), { state: "unpublished" });
  await call("p314-coach", "publishLineup", envelope("p314-m1", 1, { teamId: A, action: "publish" }));
  const family = await call("p314-guardian", "getLineupView", { eventId: "p314-m1", teamId: A, participantId: "p314-p1" });
  assert.equal(family.state, "published");
  assert.equal(JSON.stringify(family).includes("Synthetic private coaching note"), false);

  const act = (expectedRevision, payload) => call("p314-coach", "recordPlayAction", envelope("p314-m1", expectedRevision, { teamId: A, ...payload }));
  await timed("playStart", () => act(0, { kind: "start", periodCount: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 150));
  await act(1, { kind: "substitute", unitId: "starting", outParticipantId: "p314-p2", inParticipantId: "p314-p3" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await act(2, { kind: "endPeriod" });
  const corrected = await act(3, { kind: "correct", targetSequence: 2, atElapsedMs: 50, outParticipantId: "p314-p2", inParticipantId: "p314-p4", reason: "Scorer sheet shows the change earlier" });
  assert.deepEqual(corrected.affectedParticipantIds, ["p314-p2", "p314-p3", "p314-p4"]);
  await timed("finalizePlaySession", () => call("p314-coach", "finalizePlaySession", envelope("p314-m1", 4, { teamId: A })));
  const sessionPath = `events/p314-m1/playSessions/${A}`;
  const session = (await db.doc(sessionPath).get()).data();
  const actions = (await db.collection(`${sessionPath}/actions`).orderBy("sequence").get()).docs.map((doc) => doc.data().action);
  assert.deepEqual(ledgerTotals(replayPlayLedger(actions)), session.finalTotals);
  assert.equal(session.finalTotals["p314-p2"], 50);
  assert.equal(session.finalTotals["p314-p3"], undefined);
  assert.equal(session.finalTotals["p314-p1"], session.durationMs);
  // Individual playing time stays coach-only.
  await deny(call("p314-guardian", "getPlaySession", { eventId: "p314-m1", teamId: A }));
  await deny(call("p314-manager", "getPlaySession", { eventId: "p314-m1", teamId: A }));
});

test("rehearsal: a result correction and an abandoned build converge on one active complete standings generation", async () => {
  await assert.rejects(call("p314-manager", "saveCompetitionRules", envelope("p314-cross", 0, {
    programId: scope.programId, seasonId: scope.seasonId, divisionId: scope.divisionId, name: "Cross-organization",
    format: "league", teamIds: [A, "p314-foreign-team"], rules: leagueRules, confirm: true,
  })));
  await call("p314-manager", "saveCompetitionRules", envelope("p314-league", 0, {
    programId: scope.programId, seasonId: scope.seasonId, divisionId: scope.divisionId, name: "Synthetic league", format: "league", teamIds: teams, rules: leagueRules, confirm: true,
  }));
  await finalize("p314-league", "p314-m1", played(2, 0));
  await finalize("p314-league", "p314-m2", played(1, 0));
  await finalize("p314-league", "p314-m3", played(3, 1));
  await finalize("p314-league", "p314-m4", played(1, 1));
  await timed("standingsBuild", () => standings.buildStandings(orgId, "p314-league"));
  const first = await call("p314-manager", "getStandings", { orgId, competitionId: "p314-league" });
  assert.equal(first.status, "current");
  assert.deepEqual(first.rows.map((row) => [row.teamId, row.points]), [[A, 6], [C, 3], [D, 1], [B, 1]]);
  await call("p314-coach", "getEventStandings", { eventId: "p314-m1", teamId: A });
  await deny(call("p314-coach", "getStandings", { orgId, competitionId: "p314-league" }));
  await deny(call("p314-foreign", "getStandings", { orgId, competitionId: "p314-league" }));

  // The referee sheet reverses m3. A crashed worker left a stale building generation behind.
  await call("p314-manager", "correctResult", envelope("p314-league", await resultRevision("p314-league", "p314-m3"), { eventId: "p314-m3", result: played(0, 2), reason: "Referee sheet corrected" }));
  const ref = db.doc(competitionPath("p314-league"));
  assert.equal(standings.standingsStatus((await ref.get()).data()), "updating");
  const abandoned = ref.collection("generations").doc("p314-abandoned");
  await abandoned.set({ schemaVersion: 2, orgId, competitionId: "p314-league", state: "building", startedAt: Timestamp.fromMillis(Date.now() - 20 * 60_000), sourceRevision: 0 });
  await ref.update({ standingsPendingSince: Timestamp.fromMillis(Date.now() - 120_000) });
  const reconciled = await timed("standingsReconcile", () => standings.reconcilePendingStandings(25, 60_000));
  assert.ok(reconciled.swept >= 1, JSON.stringify(reconciled));
  assert.equal((await abandoned.get()).data().state, "failed");
  const competition = (await ref.get()).data();
  assert.equal(standings.standingsStatus(competition), "current");
  const corrected = await call("p314-manager", "getStandings", { orgId, competitionId: "p314-league" });
  assert.deepEqual(corrected.rows.map((row) => [row.teamId, row.points]), [[C, 6], [A, 3], [D, 1], [B, 1]]);
  // Earlier summaries are retained until retired, but the view serves only the active generation at the corrected source.
  const active = (await ref.collection("generations").doc(competition.activeGeneration.generationId).get()).data();
  assert.equal(active.state, "complete");
  assert.equal(active.sourceRevision, competition.sourceRevision);
  assert.deepEqual([corrected.generation.active, corrected.generation.sourceRevision], [true, competition.sourceRevision]);
  assert.notEqual(first.generation.sourceRevision, corrected.generation.sourceRevision);
  timings.standingsReads = active.stats.resultReads + active.stats.teamReads;
});

test("rehearsal: a bracket winner correction blocks, previews and clears the affected final", async () => {
  await call("p314-manager", "saveCompetitionRules", envelope("p314-cup", 0, {
    programId: scope.programId, seasonId: scope.seasonId, divisionId: scope.divisionId, name: "Synthetic cup", format: "knockout", teamIds: teams, rules: knockoutRules, confirm: true,
  }));
  const seedOverride = { teamIds: teams, reason: "Synthetic draw for the rehearsal" };
  const preview = await call("p314-manager", "previewBracket", { orgId, competitionId: "p314-cup", sourceCompetitionId: null, seedOverride });
  assert.equal(preview.blocked, null);
  await call("p314-manager", "publishBracket", envelope("p314-cup", preview.bracketRevision, {
    sourceCompetitionId: null, generationId: null, sourceRevision: null, seedOverride, previewHash: preview.previewHash,
  }));
  const node = async (nodeId) => (await db.doc(`${competitionPath("p314-cup")}/bracketNodes/${nodeId}`).get()).data();
  const revision = async () => (await db.doc(competitionPath("p314-cup")).get()).data().bracketRevision;
  const link = async (nodeId, eventId) => call("p314-manager", "linkBracketEvent", envelope("p314-cup", await revision(), { nodeId, eventId }));
  const semis = [["r1-01", "p314-s1", 15], ["r1-02", "p314-s2", 15]];
  for (const [nodeId, eventId, day] of semis) {
    const [home, away] = (await node(nodeId)).teamIds;
    await db.doc(`events/${eventId}`).set(matchDoc(home, away, day));
    await link(nodeId, eventId);
    await finalize("p314-cup", eventId, played(2, 0));
  }
  const final = await node("r2-01");
  await db.doc("events/p314-final").set(matchDoc(final.teamIds[0], final.teamIds[1], 22));
  await link("r2-01", "p314-final");
  await finalize("p314-cup", "p314-final", played(1, 0));
  const champion = (await node("r2-01")).winnerTeamId;
  assert.equal(champion, final.teamIds[0]);

  const s1Revision = await resultRevision("p314-cup", "p314-s1");
  await domain(call("p314-manager", "correctResult", envelope("p314-cup", s1Revision, { eventId: "p314-s1", result: played(0, 2), reason: "Referee sheet corrected" })), "BRACKET_CORRECTION_REQUIRED");
  const review = await call("p314-manager", "previewBracketCorrection", { orgId, competitionId: "p314-cup", eventId: "p314-s1", result: played(0, 2) });
  assert.deepEqual([review.invalidatedNodeIds, review.requiresConfirmation], [["r2-01"], true]);
  await call("p314-manager", "correctBracket", envelope("p314-cup", await revision(), {
    eventId: "p314-s1", result: played(0, 2), reason: "Referee sheet corrected", resultRevision: s1Revision, invalidatedNodeIds: ["r2-01"],
  }));
  const cleared = await node("r2-01");
  assert.deepEqual([cleared.eventId, cleared.winnerTeamId, cleared.voidedPlays.map((play) => play.eventId)], [null, null, ["p314-final"]]);
  // Played history is preserved: the final's own result is untouched.
  assert.equal((await db.doc(`${competitionPath("p314-cup")}/results/p314-final`).get()).data().final.winnerTeamId, champion);
  await deny(call("p314-foreign", "getBracket", { orgId, competitionId: "p314-cup" }));
});

test("rehearsal: attendance report read cost, export and revocation", async () => {
  const filters = { kind: "attendance", programId: scope.programId, seasonId: scope.seasonId, teamId: A, fromDate: "2026-03-01", toDate: "2026-03-31" };
  const { runId } = await call("p314-coach", "requestReport", { requestId: `p314-${++seq}`, orgId, filters });
  await timed("reportBuild", () => reports.buildReport(orgId, runId));
  const { run, rows } = await call("p314-coach", "getReportRun", { orgId, runId });
  assert.equal(run.state, "complete");
  // Hand calculation for m1: present 2, late 1, absent 1 of 4 eligible.
  assert.deepEqual(run.summary.presenceRate, { numerator: 3, denominator: 4, rate: 0.75 });
  assert.deepEqual(run.summary.completionCoverage, { numerator: 4, denominator: 4, rate: 1 });
  assert.deepEqual(rows.map((row) => row.teamId), [A]);
  const reads = run.manifest.eventReads + run.manifest.snapshotReads + run.manifest.attendanceReads;
  // One event page, plus one snapshot and one attendance page per event in scope (m1 has four rows).
  assert.ok(reads <= 1 + 2 * (run.manifest.eventsInScope + 3), `report read cost ${reads}`);
  timings.reportReads = reads;
  const file = await timed("reportExport", () => call("p314-coach", "exportReport", { orgId, runId }));
  assert.equal(file.rowCount, run.rowCount);
  assert.equal(/Synthetic p\d|Synthetic private/.test(file.csv), false);
  await deny(call("p314-foreign", "exportReport", { orgId, runId }));
  await deny(call("p314-guardian", "exportReport", { orgId, runId }));

  // Revoking the coach closes every Phase 3 surface on the next call.
  await db.doc(`teamMembers/${A}_p314-coach`).update({ status: "revoked" });
  try {
    await deny(call("p314-coach", "exportReport", { orgId, runId }));
    await deny(call("p314-coach", "getReportRun", { orgId, runId }));
    await deny(call("p314-coach", "getLineup", { eventId: "p314-m1", teamId: A }));
    await deny(call("p314-coach", "getPlaySession", { eventId: "p314-m1", teamId: A }));
    await deny(call("p314-coach", "requestReport", { requestId: `p314-${++seq}`, orgId, filters }));
  } finally {
    await db.doc(`teamMembers/${A}_p314-coach`).update({ status: "active" });
  }
});

test("rehearsal: rollover carries teams forward without staff, rosters or history edits", async () => {
  const history = await Promise.all([`${competitionPath("p314-league")}/results/p314-m3`, `events/p314-m1/coaching/${A}`, `events/p314-m1/playSessions/${A}`]
    .map(async (path) => [path, (await db.doc(path).get()).data()]));
  const input = { orgId, sourceSeasonId: scope.seasonId, target: { name: "Fall 2026", startsOn: "2026-09-01", endsOn: "2026-11-30" }, excludedTeamIds: [] };
  await deny(call("p314-foreign", "previewRollover", input));
  await deny(call("p314-coach", "previewRollover", input));
  const preview = await call("p314-manager", "previewRollover", input);
  const { job } = await call("p314-manager", "commitRollover", { requestId: `p314-${++seq}`, ...input, previewHash: preview.previewHash });
  const outcome = await timed("rolloverRun", () => rollover.runRolloverJob(orgId, job.jobId));
  assert.equal(outcome.state, "complete");
  const targets = (await db.collection("teams").where("seasonId", "==", job.targetSeasonId).get()).docs;
  assert.equal(targets.length, teams.length);
  for (const target of targets) {
    assert.equal(target.data().orgId, orgId);
    assert.equal((await db.collection(`teams/${target.id}/roster`).limit(1).get()).size, 0);
  }
  const staff = await db.collection("teamMembers").where("teamId", "in", targets.map((target) => target.id)).get();
  assert.equal(staff.size, 0);
  assert.equal((await db.collection(`organizations/${orgId}/competitions`).where("seasonId", "==", job.targetSeasonId).get()).size, 0);
  for (const [path, data] of history) assert.deepEqual((await db.doc(path).get()).data(), data, path);
});
