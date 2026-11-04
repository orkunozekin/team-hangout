import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { deleteApp, initializeApp } from "firebase/app";
import { getAuth, connectAuthEmulator, signInWithEmailAndPassword } from "firebase/auth";
import { getFunctions, connectFunctionsEmulator, httpsCallable } from "firebase/functions";
import { projectId, requireEmulators } from "./fixtures.mjs";

const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { initializeApp: adminApp, deleteApp: deleteAdmin } = require("firebase-admin/app");
const { getAuth: adminAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
requireEmulators();

const users = ["p37-manager", "p37-other-staff", "p37-coach", "p37-player", "p37-outsider", "p37-foreign"];
const scope = { orgId: "p37-org", programId: "p37-program", seasonId: "p37-season", divisionId: "p37-division" };
const [A, B, C, D] = ["p37-a", "p37-b", "p37-c", "p37-d"];
const teams = [A, B, C, D];
const past = Timestamp.fromDate(new Date("2026-03-01T18:00:00Z"));
const future = Timestamp.fromDate(new Date("2099-03-01T18:00:00Z"));
/** Synthetic policies for tests only; a pilot manager has not approved real league rules. */
const leagueRules = {
  rulesSchemaVersion: 1, points: { win: 3, draw: 1, loss: 0, forfeitWin: 3, forfeitLoss: 0 }, allowDraws: true, forfeitScore: { winner: 3, loser: 0 },
  countedOutcomes: ["played", "forfeit"], tieBreakers: ["tablePoints", "scoreDifferential", "scoresFor", "wins"], scoreDifferentialCap: null, knockoutDeciders: [],
};
const knockoutRules = { ...leagueRules, allowDraws: false, points: { ...leagueRules.points, draw: 0 }, knockoutDeciders: ["penalties"] };

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
const played = (homeScore, awayScore, winnerTeamId = null, decider = null) => ({ outcome: "played", homeScore, awayScore, forfeitingTeamId: null, winnerTeamId, decider });
const envelope = (competitionId, expectedRevision, payload) => ({ requestId: `p37-${++seq}`, orgId: scope.orgId, resourceId: competitionId, expectedRevision, payload });
const competition = async (competitionId) => (await db.doc(path(competitionId)).get()).data();
const node = async (competitionId, nodeId) => (await db.doc(`${path(competitionId)}/bracketNodes/${nodeId}`).get()).data();
const resultRevision = async (competitionId, eventId) => (await db.doc(`${path(competitionId)}/results/${eventId}`).get()).data()?.revision ?? 0;
const bracket = (competitionId) => call("p37-manager", "getBracket", { orgId: scope.orgId, competitionId });

async function create(competitionId, format, teamIds = teams) {
  await call("p37-manager", "saveCompetitionRules", envelope(competitionId, 0, {
    programId: scope.programId, seasonId: scope.seasonId, divisionId: scope.divisionId, name: `Synthetic ${competitionId}`,
    format, teamIds, rules: format === "knockout" ? knockoutRules : leagueRules, confirm: true,
  }));
}

async function match(eventId, home, away, startsAt = past) {
  await db.doc(`events/${eventId}`).set({
    ...meta(), ...scope, title: `Synthetic ${eventId}`, type: "match", teamId: home, teamIds: [home, away], homeTeamId: home, awayTeamId: away,
    startsAt, endsAt: startsAt, timeZone: "America/Chicago", status: "scheduled", publicationState: "published", publicationOperationId: null, deletedAt: null,
  });
}

async function finalize(competitionId, eventId, result, requestId) {
  const data = envelope(competitionId, await resultRevision(competitionId, eventId), { eventId, result });
  if (requestId) data.requestId = requestId;
  return call("p37-manager", "finalizeResult", data);
}

async function correct(name, competitionId, eventId, result, extra = {}) {
  const current = await competition(competitionId);
  const revision = await resultRevision(competitionId, eventId);
  if (name === "correctResult") return call("p37-manager", name, envelope(competitionId, revision, { eventId, result, reason: "Referee sheet corrected" }));
  return call("p37-manager", name, envelope(competitionId, current.bracketRevision ?? 0, { eventId, result, reason: "Referee sheet corrected", resultRevision: revision, ...extra }));
}

async function publishManual(competitionId, order, reason = "Manager drew seeds at the league meeting") {
  const seedOverride = { teamIds: order, reason };
  const preview = await call("p37-manager", "previewBracket", { orgId: scope.orgId, competitionId, sourceCompetitionId: null, seedOverride });
  assert.equal(preview.blocked, null);
  return call("p37-manager", "publishBracket", envelope(competitionId, preview.bracketRevision, {
    sourceCompetitionId: null, generationId: null, sourceRevision: null, seedOverride, previewHash: preview.previewHash,
  }));
}

const link = async (competitionId, nodeId, eventId) =>
  call("p37-manager", "linkBracketEvent", envelope(competitionId, (await competition(competitionId)).bracketRevision, { nodeId, eventId }));

async function settled(competitionId, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await competition(competitionId);
    if (worker.standingsStatus(row) === "current") return row;
    if (Date.now() > deadline) throw new Error(`Standings for ${competitionId} did not settle.`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

before(async () => {
  admin = adminApp({ projectId });
  db = getFirestore(admin);
  worker = require("./lib/competition/generations.js");
  for (const uid of users) {
    const app = initializeApp({ projectId, apiKey: "demo-key" }, uid);
    apps[uid] = app;
    connectAuthEmulator(getAuth(app), "http://127.0.0.1:9099", { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), "127.0.0.1", 5001);
    await adminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password: "SyntheticPassword123!" }).catch(() => {});
    await db.doc(`users/${uid}`).set({ uid, appRole: "user" });
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, "SyntheticPassword123!");
  }
  await db.recursiveDelete(db.collection(`organizations/${scope.orgId}/competitions`));
  const batch = db.batch();
  batch.set(db.doc(`organizations/${scope.orgId}`), { ...meta(), name: "Synthetic league", features: { organizationV2: true, households: true } });
  batch.set(db.doc("organizations/p37-foreign-org"), { ...meta(), name: "Foreign league", features: { organizationV2: true } });
  for (const [kind, name] of [["programs", scope.programId], ["programs", "p37-program-2"], ["seasons", scope.seasonId], ["divisions", scope.divisionId]]) {
    batch.set(db.doc(`organizations/${scope.orgId}/${kind}/${name}`), { ...meta(), ...scope, ...(name === "p37-program-2" ? { programId: name } : {}), name });
  }
  batch.set(db.doc(`organizations/${scope.orgId}/members/p37-manager`), { ...meta(), orgId: scope.orgId, roles: ["orgAdmin"], programIds: [] });
  batch.set(db.doc(`organizations/${scope.orgId}/members/p37-other-staff`), { ...meta(), orgId: scope.orgId, roles: ["programStaff"], programIds: ["p37-program-2"] });
  batch.set(db.doc("organizations/p37-foreign-org/members/p37-foreign"), { ...meta(), orgId: "p37-foreign-org", roles: ["orgAdmin"], programIds: [] });
  for (const id of teams) batch.set(db.doc(`teams/${id}`), { ...meta(), ...scope, name: `Team ${id.slice(-1).toUpperCase()}` });
  for (const [uid, roles] of [["p37-coach", ["coach"]], ["p37-player", ["player"]]]) {
    batch.set(db.doc(`teamMembers/${A}_${uid}`), { ...meta(), orgId: scope.orgId, teamId: A, userId: uid, roles, status: "active" });
  }
  await batch.commit();
  await match("p37-view", A, B, future);
});

after(async () => {
  await Promise.all(Object.values(apps).map((app) => deleteApp(app)));
  if (admin) await deleteAdmin(admin);
});

test("unresolved seed ties block publication, a reasoned override publishes, and a stale preview cannot publish", async () => {
  await create("p37-league", "league");
  for (const [eventId, home, homeScore, away, awayScore] of [["p37-l1", A, 1, B, 0], ["p37-l2", C, 1, D, 0]]) {
    await match(eventId, home, away);
    await finalize("p37-league", eventId, played(homeScore, awayScore));
  }
  await settled("p37-league");
  await create("p37-seeded", "knockout");
  const request = { orgId: scope.orgId, competitionId: "p37-seeded", sourceCompetitionId: "p37-league", seedOverride: null };
  const tied = await call("p37-manager", "previewBracket", request);
  assert.equal(tied.blocked, "SEED_TIE_UNRESOLVED");
  assert.deepEqual(tied.unresolvedTies.map((group) => group.map((team) => team.teamId)), [[A, C], [B, D]]);
  const generationId = (await competition("p37-league")).activeGeneration.generationId;
  const publish = (preview, seedOverride) => call("p37-manager", "publishBracket", envelope("p37-seeded", preview.bracketRevision, {
    sourceCompetitionId: "p37-league", generationId: preview.source.generationId, sourceRevision: preview.source.sourceRevision, seedOverride, previewHash: preview.previewHash,
  }));
  await domain(publish(tied, null), "SEED_TIE_UNRESOLVED");
  for (const uid of ["p37-coach", "p37-player", "p37-other-staff", "p37-foreign"]) await deny(call(uid, "previewBracket", request));

  const seedOverride = { teamIds: [C, A, D, B], reason: "Coin toss recorded at the managers meeting" };
  const stale = await call("p37-manager", "previewBracket", { ...request, seedOverride });
  assert.equal(stale.blocked, null);
  assert.equal(stale.source.generationId, generationId);
  // A newer final result changes the seeding table, so the earlier preview can no longer publish.
  await match("p37-l3", A, C);
  await finalize("p37-league", "p37-l3", played(2, 0));
  await settled("p37-league");
  await domain(publish(stale, seedOverride), "BRACKET_PREVIEW_CHANGED");
  const fresh = await call("p37-manager", "previewBracket", { ...request, seedOverride });
  assert.notEqual(fresh.source.generationId, generationId);
  await publish(fresh, seedOverride);
  const view = await bracket("p37-seeded");
  assert.equal(view.bracket.override.reason, seedOverride.reason);
  assert.deepEqual(view.nodes.filter((row) => row.round === 1).map((row) => row.teams.map((team) => team.teamId)), [[C, B], [A, D]]);
  const history = await db.collection(`${path("p37-seeded")}/bracketHistory`).where("kind", "==", "publish").get();
  assert.equal(history.docs[0].data().reason, seedOverride.reason);
});

test("a bye has no match, a delayed result waits, a tied knockout needs a decider and duplicate progression is a no-op", async () => {
  await create("p37-three", "knockout", [A, B, C]);
  const eventCount = (await db.collection("events").where("orgId", "==", scope.orgId).get()).size;
  await publishManual("p37-three", [A, B, C]);
  // Publishing creates no event, attendance or booking for the bye.
  assert.equal((await db.collection("events").where("orgId", "==", scope.orgId).get()).size, eventCount);
  const published = await bracket("p37-three");
  const bye = published.nodes.find((row) => row.nodeId === "r1-01");
  assert.deepEqual([bye.state, bye.eventId, bye.winnerTeamId], ["bye", null, A]);
  assert.deepEqual(published.nodes.find((row) => row.nodeId === "r2-01").teams.map((team) => team?.teamId ?? null), [A, null]);

  await match("p37-bye", A, B);
  await domain(link("p37-three", "r1-01", "p37-bye"), "BYE_NO_EVENT");
  await domain(link("p37-three", "r2-01", "p37-bye"), "BRACKET_NODE_WAITING");
  await match("p37-semi", B, C);
  await domain(link("p37-three", "r1-02", "p37-bye"), "BRACKET_EVENT_MISMATCH");
  await link("p37-three", "r1-02", "p37-semi");
  // Delayed result: the match started without a final result, so the winner is unresolved and nothing advances.
  let semi = (await bracket("p37-three")).nodes.find((row) => row.nodeId === "r1-02");
  assert.deepEqual([semi.state, semi.winnerPending], ["scheduled", true]);
  assert.deepEqual((await node("p37-three", "r2-01")).teamIds, [A, null]);
  await domain(finalize("p37-three", "p37-semi", played(1, 1)), "INVALID_KNOCKOUT_DRAW");

  const revision = (await competition("p37-three")).bracketRevision;
  const first = await finalize("p37-three", "p37-semi", played(1, 1, C, "penalties"), "p37-dup-final");
  assert.equal((await competition("p37-three")).bracketRevision, revision + 1);
  const replay = await call("p37-manager", "finalizeResult", { requestId: "p37-dup-final", orgId: scope.orgId, resourceId: "p37-three", expectedRevision: 0, payload: { eventId: "p37-semi", result: played(1, 1, C, "penalties") } });
  assert.deepEqual(replay, first);
  assert.equal((await competition("p37-three")).bracketRevision, revision + 1);
  semi = await node("p37-three", "r1-02");
  assert.equal(semi.winnerTeamId, C);
  assert.deepEqual((await node("p37-three", "r2-01")).teamIds, [A, C]);
  const progress = await db.collection(`${path("p37-three")}/bracketHistory`).where("kind", "==", "progress").get();
  assert.equal(progress.size, 1);
  await domain(link("p37-three", "r1-02", "p37-bye"), "BRACKET_NODE_DECIDED");

  // Published viewers: a rostered team member sees the bracket; outsiders and foreign staff do not.
  const family = await call("p37-player", "getEventBracket", { eventId: "p37-view", teamId: A, competitionId: "p37-three" });
  assert.equal(family.bracket.nodes.length, 3);
  for (const uid of ["p37-outsider", "p37-foreign"]) await deny(call(uid, "getEventBracket", { eventId: "p37-view", teamId: A }));
});

test("corrections clear unstarted descendants automatically and block started ones until an audited confirmation", async () => {
  await create("p37-four", "knockout");
  await publishManual("p37-four", [A, B, C, D]);
  await match("p37-q1", A, D);
  await match("p37-q2", B, C);
  await link("p37-four", "r1-01", "p37-q1");
  await link("p37-four", "r1-02", "p37-q2");
  await finalize("p37-four", "p37-q1", played(2, 0));
  await finalize("p37-four", "p37-q2", played(1, 0));
  assert.deepEqual((await node("p37-four", "r2-01")).teamIds, [A, B]);
  await match("p37-final-future", A, B, future);
  await link("p37-four", "r2-01", "p37-final-future");
  // A linked match keeps its match identity until the bracket links another match.
  await domain(call("p37-manager", "mutateEventSchedule", {
    requestId: `p37-${++seq}`, eventId: "p37-final-future", expectedRevision: 1, action: "edit", patch: { type: "practice" }, reason: "Wrong type",
  }), "BRACKET_LINKED");
  await domain(publishManual("p37-four", [D, C, B, A]), "BRACKET_LOCKED");

  // The final has not started: correcting the semifinal winner clears its participant and match link in one transaction.
  await correct("correctResult", "p37-four", "p37-q1", played(0, 2));
  let final = await node("p37-four", "r2-01");
  assert.deepEqual([final.teamIds, final.eventId, final.winnerTeamId, final.voidedPlays], [[D, B], null, null, []]);
  assert.equal((await db.doc(`events/p37-final-future/bracketLinks/p37-four`).get()).exists, false);

  await match("p37-final", D, B);
  await link("p37-four", "r2-01", "p37-final");
  await finalize("p37-four", "p37-final", played(3, 1));
  assert.equal((await node("p37-four", "r2-01")).winnerTeamId, D);
  const sourceRevision = (await competition("p37-four")).sourceRevision;

  // The final was played: a winner change is blocked until an administrator reviews the invalidated games.
  await domain(correct("correctResult", "p37-four", "p37-q1", played(2, 0)), "BRACKET_CORRECTION_REQUIRED");
  const preview = await call("p37-manager", "previewBracketCorrection", { orgId: scope.orgId, competitionId: "p37-four", eventId: "p37-q1", result: played(2, 0) });
  assert.deepEqual([preview.nodeId, preview.previousWinnerTeamId, preview.winnerTeamId, preview.invalidatedNodeIds, preview.requiresConfirmation], ["r1-01", D, A, ["r2-01"], true]);
  await deny(call("p37-coach", "previewBracketCorrection", { orgId: scope.orgId, competitionId: "p37-four", eventId: "p37-q1", result: played(2, 0) }));
  await domain(correct("correctBracket", "p37-four", "p37-q1", played(2, 0), { invalidatedNodeIds: [] }), "BRACKET_PREVIEW_CHANGED");
  assert.equal((await competition("p37-four")).sourceRevision, sourceRevision);
  await correct("correctBracket", "p37-four", "p37-q1", played(2, 0), { invalidatedNodeIds: ["r2-01"] });

  final = await node("p37-four", "r2-01");
  assert.deepEqual([final.teamIds, final.eventId, final.winnerTeamId], [[A, B], null, null]);
  assert.deepEqual(final.voidedPlays.map((play) => [play.eventId, play.winnerTeamId]), [["p37-final", D]]);
  // Played history stays auditable: the final's result is untouched and the audit names the invalidated game.
  assert.equal((await db.doc(`${path("p37-four")}/results/p37-final`).get()).data().final.winnerTeamId, D);
  const audit = (await db.collection(`${path("p37-four")}/bracketHistory`).where("kind", "==", "correct").get()).docs.map((doc) => doc.data())
    .sort((a, b) => a.createdAt.toMillis() - b.createdAt.toMillis());
  assert.deepEqual(audit.map((row) => row.invalidatedNodeIds), [[], ["r2-01"]]);
  assert.equal(audit.every((row) => row.reason === "Referee sheet corrected"), true);
  const view = await bracket("p37-four");
  assert.equal(view.nodes.find((row) => row.nodeId === "r2-01").voidedPlays.length, 1);

  // Correcting back restores the invalidated pairing, but the voided final cannot be relinked to declare a winner.
  await correct("correctResult", "p37-four", "p37-q1", played(0, 2));
  assert.deepEqual((await node("p37-four", "r2-01")).teamIds, [D, B]);
  await domain(link("p37-four", "r2-01", "p37-final"), "BRACKET_EVENT_VOIDED");
  assert.equal((await node("p37-four", "r2-01")).winnerTeamId, null);
});
