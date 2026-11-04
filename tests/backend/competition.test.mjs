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

const users = ["p35-manager", "p35-staff", "p35-other-staff", "p35-coach", "p35-away-coach", "p35-revoked", "p35-guardian", "p35-support", "p35-foreign"];
let admin;
let db;
let seq = 0;
const apps = {};
const call = async (uid, name, data) => (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const deny = (promise) => assert.rejects(promise, { code: "functions/permission-denied" });
const domain = (promise, domainCode) => assert.rejects(promise, (error) => {
  assert.equal(error.details?.domainCode, domainCode, error.message);
  return true;
});
const scope = { orgId: "p35-org", programId: "p35-program", seasonId: "p35-season", divisionId: "p35-division" };
const meta = () => ({ schemaVersion: 2, revision: 1, status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
const competitionId = "p35-league";
const knockoutId = "p35-cup";
const competitionPath = `organizations/${scope.orgId}/competitions/${competitionId}`;
const teams = ["p35-home", "p35-away", "p35-third"];
const past = Timestamp.fromDate(new Date("2026-03-01T18:00:00Z"));
const future = Timestamp.fromDate(new Date("2099-03-01T18:00:00Z"));

/** Synthetic policy for tests only. A pilot manager has not approved real league rules (external gate). */
const rules = {
  rulesSchemaVersion: 1,
  points: { win: 3, draw: 1, loss: 0, forfeitWin: 3, forfeitLoss: 0 },
  allowDraws: true,
  forfeitScore: { winner: 3, loser: 0 },
  countedOutcomes: ["played", "forfeit"],
  tieBreakers: ["tablePoints", "headToHeadPoints", "scoreDifferential", "scoresFor", "wins"],
  scoreDifferentialCap: 5,
  knockoutDeciders: [],
};
const knockoutRules = { ...rules, allowDraws: false, points: { ...rules.points, draw: 0 }, knockoutDeciders: ["penalties"] };

const saveRules = (uid, expectedRevision, payload = {}, id = competitionId, requestId = `p35-${++seq}`) =>
  call(uid, "saveCompetitionRules", {
    requestId, orgId: scope.orgId, resourceId: id, expectedRevision,
    payload: { programId: scope.programId, seasonId: scope.seasonId, divisionId: scope.divisionId, name: "Synthetic league", format: "league", teamIds: teams, rules, confirm: true, ...payload },
  });
const played = (homeScore, awayScore, extra = {}) => ({ outcome: "played", homeScore, awayScore, forfeitingTeamId: null, winnerTeamId: null, decider: null, ...extra });
const propose = (uid, expectedRevision, result, { eventId = "p35-match", teamId = "p35-home", id = competitionId, requestId = `p35-${++seq}` } = {}) =>
  call(uid, "proposeResult", { requestId, orgId: scope.orgId, resourceId: id, expectedRevision, payload: { eventId, teamId, result } });
const finalize = (uid, expectedRevision, result, { eventId = "p35-match", id = competitionId, requestId = `p35-${++seq}` } = {}) =>
  call(uid, "finalizeResult", { requestId, orgId: scope.orgId, resourceId: id, expectedRevision, payload: { eventId, result } });
const correct = (uid, expectedRevision, result, reason, { eventId = "p35-match", requestId = `p35-${++seq}` } = {}) =>
  call(uid, "correctResult", { requestId, orgId: scope.orgId, resourceId: competitionId, expectedRevision, payload: { eventId, result, reason } });
const history = async (id = competitionId) =>
  (await db.collection(`organizations/${scope.orgId}/competitions/${id}/resultHistory`).orderBy("afterRevision").get()).docs.map((d) => d.data());

before(async () => {
  admin = adminApp({ projectId }, "p35-admin-app");
  db = getFirestore(admin);
  for (const uid of users) {
    const app = initializeApp({ projectId, apiKey: "demo-key" }, uid);
    apps[uid] = app;
    connectAuthEmulator(getAuth(app), "http://127.0.0.1:9099", { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), "127.0.0.1", 5001);
    connectFirestoreEmulator(clientDb(app), "127.0.0.1", 8080);
    await adminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password: "SyntheticPassword123!" }).catch(() => {});
    await db.doc(`users/${uid}`).set({ uid, appRole: uid === "p35-support" ? "superAdmin" : "user" });
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, "SyntheticPassword123!");
  }
});

after(async () => {
  await Promise.all(Object.values(apps).map((app) => deleteApp(app)));
  if (admin) await deleteAdmin(admin);
});

function match(batch, eventId, fields = {}) {
  const [home, away] = fields.teamIds ?? ["p35-home", "p35-away"];
  batch.set(db.doc(`events/${eventId}`), {
    ...meta(), ...scope, title: `Synthetic ${eventId}`, type: "match", teamId: home, teamIds: [home, away], homeTeamId: home, awayTeamId: away,
    startsAt: past, endsAt: past, timeZone: "America/Chicago", status: "scheduled", publicationState: "published", publicationOperationId: null, deletedAt: null,
    ...fields,
  });
}

beforeEach(async () => {
  await db.recursiveDelete(db.collection(`organizations/${scope.orgId}/competitions`));
  await db.recursiveDelete(db.collection("events/p35-match/competitionResults"));
  const batch = db.batch();
  batch.delete(db.doc("events/p35-forfeit"));
  batch.set(db.doc(`organizations/${scope.orgId}`), { ...meta(), name: "Synthetic league", features: { organizationV2: true, households: true } });
  batch.set(db.doc("organizations/p35-foreign-org"), { ...meta(), name: "Foreign league", features: { organizationV2: true } });
  for (const [kind, name] of [["programs", scope.programId], ["programs", "p35-program-2"], ["seasons", scope.seasonId], ["divisions", scope.divisionId]]) {
    batch.set(db.doc(`organizations/${scope.orgId}/${kind}/${name}`), { ...meta(), ...scope, ...(kind === "programs" && name !== scope.programId ? { programId: name } : {}), name });
  }
  batch.set(db.doc(`organizations/${scope.orgId}/members/p35-manager`), { ...meta(), orgId: scope.orgId, roles: ["orgAdmin"], programIds: [] });
  batch.set(db.doc(`organizations/${scope.orgId}/members/p35-staff`), { ...meta(), orgId: scope.orgId, roles: ["programStaff"], programIds: [scope.programId] });
  batch.set(db.doc(`organizations/${scope.orgId}/members/p35-other-staff`), { ...meta(), orgId: scope.orgId, roles: ["programStaff"], programIds: ["p35-program-2"] });
  batch.set(db.doc("organizations/p35-foreign-org/members/p35-foreign"), { ...meta(), orgId: "p35-foreign-org", roles: ["orgAdmin"], programIds: [] });
  for (const id of teams) batch.set(db.doc(`teams/${id}`), { ...meta(), ...scope, name: id.replace("p35-", "Synthetic ") });
  batch.set(db.doc("teams/p35-foreign-team"), { ...meta(), orgId: "p35-foreign-org", programId: "x", seasonId: "x", divisionId: "x", name: "Foreign" });
  const member = (teamId, uid, status = "active") =>
    batch.set(db.doc(`teamMembers/${teamId}_${uid}`), { ...meta(), orgId: scope.orgId, teamId, userId: uid, roles: ["coach"], status });
  member("p35-home", "p35-coach");
  member("p35-away", "p35-away-coach");
  member("p35-home", "p35-revoked", "revoked");
  member("p35-third", "p35-third-coach");
  batch.set(db.doc("teamMembers/p35-home_p35-guardian"), { ...meta(), orgId: scope.orgId, teamId: "p35-home", userId: "p35-guardian", roles: ["player"], status: "active" });
  match(batch, "p35-match");
  match(batch, "p35-cancelled", { status: "cancelled" });
  match(batch, "p35-future", { startsAt: future, endsAt: future });
  match(batch, "p35-outside", { teamIds: ["p35-home", "p35-fourth"], awayTeamId: "p35-fourth" });
  batch.set(db.doc("teams/p35-fourth"), { ...meta(), ...scope, name: "Not in competition" });
  batch.set(db.doc("events/p35-external"), {
    ...meta(), ...scope, title: "Synthetic external opponent", type: "match", teamId: "p35-home", teamIds: ["p35-home"], opponentName: "Visitors",
    startsAt: past, endsAt: past, timeZone: "America/Chicago", status: "scheduled", publicationState: "published", publicationOperationId: null, deletedAt: null,
  });
  await batch.commit();
});

test("rules are explicit, versioned on confirmation and never inferred from a sport name", async () => {
  await assert.rejects(saveRules("p35-manager", 0, { rules: { ...rules, sport: "soccer" } }), { code: "functions/invalid-argument" });
  await domain(saveRules("p35-manager", 0, { rules: { ...rules, points: { ...rules.points, win: -1 } } }), "INVALID_RULES");
  await domain(saveRules("p35-manager", 0, { format: "knockout", rules: { ...rules, knockoutDeciders: [] } }), "INVALID_RULES");
  await domain(saveRules("p35-manager", 0, { teamIds: ["p35-home", "p35-foreign-team"] }), "TEAM_SCOPE_MISMATCH");

  const draft = await saveRules("p35-manager", 0, { confirm: false });
  assert.deepEqual([draft.state, draft.activeRulesVersion], ["draft", null]);
  const confirmed = await saveRules("p35-staff", 1);
  assert.deepEqual([confirmed.state, confirmed.activeRulesVersion], ["confirmed", 1]);
  // Re-confirming unchanged rules keeps the same immutable version.
  assert.equal((await saveRules("p35-manager", 2)).activeRulesVersion, 1);
  const changed = await saveRules("p35-manager", 3, { rules: { ...rules, scoreDifferentialCap: null }, confirm: false });
  assert.deepEqual([changed.state, changed.activeRulesVersion], ["draft", 1]);
  assert.equal((await saveRules("p35-manager", 4, { rules: { ...rules, scoreDifferentialCap: null } })).activeRulesVersion, 2);
  const v1 = (await db.doc(`${competitionPath}/rulesVersions/1`).get()).data();
  assert.equal(v1.rules.scoreDifferentialCap, 5);
  await domain(saveRules("p35-manager", 5, { format: "knockout", rules: knockoutRules }), "IMMUTABLE_SCOPE");
  await domain(saveRules("p35-manager", 1), "STALE_REVISION");

  const view = await call("p35-staff", "getCompetition", { orgId: scope.orgId, competitionId });
  assert.deepEqual(view.rulesVersions.map((row) => row.version), [2, 1]);
  assert.equal(view.competition.rulesState, "confirmed");
  assert.deepEqual(view.matches.map((row) => row.eventId).sort(), ["p35-cancelled", "p35-future", "p35-match"]);
  assert.equal((await call("p35-manager", "listCompetitions", { orgId: scope.orgId, programId: scope.programId })).competitions.length, 1);
});

test("managers outside the program, coaches, guardians, platform support and other tenants cannot configure or score", async () => {
  for (const uid of ["p35-other-staff", "p35-coach", "p35-guardian", "p35-support", "p35-foreign"]) {
    await deny(saveRules(uid, 0));
  }
  await saveRules("p35-manager", 0);
  for (const uid of ["p35-other-staff", "p35-coach", "p35-guardian", "p35-support", "p35-foreign"]) {
    await deny(finalize(uid, 0, played(2, 1)));
    await deny(call(uid, "getCompetition", { orgId: scope.orgId, competitionId }));
  }
  // Staff cannot propose as a coach, and a revoked or foreign coach cannot propose.
  for (const uid of ["p35-manager", "p35-revoked", "p35-guardian", "p35-support", "p35-foreign"]) await deny(propose(uid, 0, played(1, 0)));
  // A coach can only propose for their own side.
  await deny(propose("p35-coach", 0, played(1, 0), { teamId: "p35-away" }));
  // Direct client reads stay denied; access is callable-only.
  await assert.rejects(getDoc(doc(clientDb(apps["p35-manager"]), competitionPath)), { code: "permission-denied" });
  assert.equal(await db.collection(`${competitionPath}/results`).count().get().then((s) => s.data().count), 0);
});

test("result table: draws, forfeits, voids, cancelled, unplayed and external opponents", async () => {
  await saveRules("p35-manager", 0, { confirm: false });
  // Proposals are allowed before confirmation; finalization is not.
  const proposed = await propose("p35-coach", 0, played(2, 2));
  assert.equal(proposed.state, "proposed");
  await domain(finalize("p35-staff", 1, played(2, 2)), "RULES_NOT_CONFIRMED");
  await saveRules("p35-manager", 1);

  const cases = [
    { name: "draw allowed", eventId: "p35-match", result: played(2, 2), expect: { winnerTeamId: null, homeScore: 2, awayScore: 2 } },
    { name: "void on cancelled", eventId: "p35-cancelled", result: { ...played(null, null), outcome: "void" }, expect: { homeScore: null, winnerTeamId: null } },
  ];
  let revision = 1;
  for (const row of cases) {
    const result = await finalize("p35-staff", row.eventId === "p35-match" ? revision : 0, row.result, { eventId: row.eventId });
    assert.equal(result.state, "final", row.name);
    const stored = (await db.doc(`${competitionPath}/results/${row.eventId}`).get()).data();
    for (const [key, value] of Object.entries(row.expect)) assert.equal(stored.final[key], value, `${row.name}: ${key}`);
    assert.equal(stored.final.appliedRulesVersion, 1);
  }
  // Played or forfeit results on cancelled or unplayed matches would invent losses or zero scores.
  await domain(propose("p35-coach", 0, played(1, 0), { eventId: "p35-future" }), "EVENT_NOT_PLAYED");
  await domain(finalize("p35-staff", 0, { ...played(null, null), outcome: "forfeit", forfeitingTeamId: "p35-away" }, { eventId: "p35-future" }), "EVENT_NOT_PLAYED");
  // Matches outside the competition and one-sided external-opponent events never enter it.
  await domain(finalize("p35-staff", 0, played(1, 0), { eventId: "p35-outside" }), "NOT_COMPETITION_MATCH");
  await domain(finalize("p35-staff", 0, played(1, 0), { eventId: "p35-external" }), "NOT_COMPETITION_MATCH");
  const external = await call("p35-coach", "getEventResults", { eventId: "p35-external", teamId: "p35-home" });
  assert.deepEqual([external.externalOpponent, external.competitions.length], [true, 0]);

  // Forfeit scores come from the confirmed policy and remain marked.
  await db.doc("events/p35-forfeit").set({ ...(await db.doc("events/p35-match").get()).data(), title: "Forfeit" });
  await finalize("p35-staff", 0, { ...played(null, null), outcome: "forfeit", forfeitingTeamId: "p35-home" }, { eventId: "p35-forfeit" });
  const forfeit = (await db.doc(`${competitionPath}/results/p35-forfeit`).get()).data().final;
  assert.deepEqual([forfeit.outcome, forfeit.homeScore, forfeit.awayScore, forfeit.winnerTeamId], ["forfeit", 0, 3, "p35-away"]);
  await domain(finalize("p35-staff", 0, played(-1, 0), { eventId: "p35-future" }), "INVALID_RESULT");

  const competition = (await db.doc(competitionPath).get()).data();
  assert.deepEqual([competition.sourceRevision, competition.finalResultCount], [3, 3]);
  const coachView = await call("p35-coach", "getEventResults", { eventId: "p35-match", teamId: "p35-home" });
  assert.equal(coachView.competitions[0].result.status, "final");
  assert.equal(coachView.competitions[0].result.final.homeScore, 2);
});

test("knockout ties need a permitted winner and decider; league draws obey the rules", async () => {
  await saveRules("p35-manager", 0, { format: "knockout", rules: knockoutRules, name: "Synthetic cup" }, knockoutId);
  await domain(propose("p35-coach", 0, played(1, 1), { id: knockoutId }), "INVALID_KNOCKOUT_DRAW");
  await domain(finalize("p35-staff", 0, played(1, 1), { id: knockoutId }), "INVALID_KNOCKOUT_DRAW");
  await domain(finalize("p35-staff", 0, played(1, 1, { winnerTeamId: "p35-home", decider: "shootout" }), { id: knockoutId }), "INVALID_KNOCKOUT_DRAW");
  await assert.rejects(finalize("p35-staff", 0, played(2, 1, { decider: "penalties", winnerTeamId: "p35-home" }), { id: knockoutId }), { code: "functions/invalid-argument" });
  await finalize("p35-staff", 0, played(1, 1, { winnerTeamId: "p35-away", decider: "penalties" }), { id: knockoutId });
  const stored = (await db.doc(`organizations/${scope.orgId}/competitions/${knockoutId}/results/p35-match`).get()).data().final;
  assert.deepEqual([stored.winnerTeamId, stored.decider], ["p35-away", "penalties"]);

  await saveRules("p35-manager", 0, { rules: { ...rules, allowDraws: false, points: { ...rules.points, draw: 0 }, knockoutDeciders: ["shootout"] } });
  await domain(finalize("p35-staff", 0, played(0, 0)), "DRAW_NOT_ALLOWED");
});

test("proposal, finalization and correction keep revisions, idempotency and immutable history", async () => {
  await saveRules("p35-manager", 0);
  const requestId = "p35-propose-retry";
  const first = await propose("p35-coach", 0, played(3, 1), { requestId });
  assert.deepEqual(await propose("p35-coach", 0, played(3, 1), { requestId }), first);
  await domain(propose("p35-coach", 0, played(4, 1), { requestId }), "REQUEST_ID_REUSED");
  // The other side's coach must reload before replacing the proposal.
  await domain(propose("p35-away-coach", 0, played(1, 3), { teamId: "p35-away" }), "STALE_REVISION");
  await propose("p35-away-coach", 1, played(3, 2), { teamId: "p35-away" });

  const final = await finalize("p35-manager", 2, played(3, 2));
  assert.deepEqual([final.revision, final.sourceRevision], [3, 1]);
  await domain(propose("p35-coach", 3, played(5, 0)), "RESULT_FINAL");
  await domain(finalize("p35-staff", 3, played(3, 2)), "RESULT_FINAL");
  await assert.rejects(correct("p35-staff", 3, played(3, 3), " "), { code: "functions/invalid-argument" });
  await domain(correct("p35-staff", 3, played(3, 2), "Same score"), "NO_CHANGE");
  await domain(correct("p35-staff", 2, played(3, 3), "Scorer sheet"), "STALE_REVISION");
  await deny(correct("p35-coach", 3, played(3, 3), "Scorer sheet"));
  const corrected = await correct("p35-staff", 3, played(3, 3), "Referee sheet shows a late equalizer");
  assert.deepEqual([corrected.revision, corrected.sourceRevision], [4, 2]);

  const stored = (await db.doc(`${competitionPath}/results/p35-match`).get()).data();
  assert.deepEqual([stored.final.homeScore, stored.final.awayScore, stored.final.correctionReason], [3, 3, "Referee sheet shows a late equalizer"]);
  assert.equal(stored.final.finalizedBy, "p35-manager");
  const rows = await history();
  assert.deepEqual(rows.map((row) => row.kind), ["propose", "propose", "finalize", "correct"]);
  assert.deepEqual(rows.map((row) => [row.beforeRevision, row.afterRevision]), [[0, 1], [1, 2], [2, 3], [3, 4]]);
  assert.equal(rows[3].before.final.awayScore, 2);
  assert.equal(rows[3].after.final.awayScore, 3);
  assert.equal(rows[3].reason, "Referee sheet shows a late equalizer");
  assert.ok(rows.every((row) => row.operationId && row.actorUid));
  const competition = (await db.doc(competitionPath).get()).data();
  assert.deepEqual([competition.sourceRevision, competition.finalResultCount], [2, 1]);
  // Teams lock once a result is final.
  await domain(saveRules("p35-manager", competition.revision, { teamIds: ["p35-home", "p35-away"] }), "COMPETITION_LOCKED");
});

test("revoked coach and archived season stop proposals at replay and write time", async () => {
  await saveRules("p35-manager", 0);
  const requestId = "p35-revoke-replay";
  await propose("p35-coach", 0, played(1, 0), { requestId });
  await db.doc("teamMembers/p35-home_p35-coach").update({ status: "revoked" });
  await deny(propose("p35-coach", 0, played(1, 0), { requestId }));
  await db.doc("teamMembers/p35-home_p35-coach").update({ status: "active" });
  await db.doc(`organizations/${scope.orgId}/seasons/${scope.seasonId}`).update({ status: "archived" });
  await domain(propose("p35-coach", 1, played(2, 0)), "HIERARCHY_ARCHIVED");
  await domain(finalize("p35-staff", 1, played(2, 0)), "HIERARCHY_ARCHIVED");
});

test("a final result blocks the event leaving match type, and a stranded final can still be voided", async () => {
  await saveRules("p35-manager", 0);
  await finalize("p35-staff", 0, played(2, 1));
  assert.ok((await db.doc(`events/p35-match/competitionResults/${competitionId}`).get()).exists);
  await domain(call("p35-manager", "mutateEventSchedule", {
    requestId: `p35-${++seq}`, eventId: "p35-match", expectedRevision: 1, action: "edit", patch: { type: "practice" }, reason: "Wrong type",
  }), "RESULT_RECORDED");
  // Simulate an event that no longer qualifies (for example edited before this guard existed).
  await db.doc("events/p35-match").update({ type: "practice", teamIds: ["p35-home"], homeTeamId: null, awayTeamId: null });
  await domain(correct("p35-staff", 1, played(3, 1), "Scorer sheet"), "NOT_COMPETITION_MATCH");
  const voided = await correct("p35-staff", 1, { ...played(null, null), outcome: "void" }, "Event was not a match");
  assert.equal(voided.revision, 2);
  const stored = (await db.doc(`${competitionPath}/results/p35-match`).get()).data();
  assert.deepEqual([stored.final.outcome, stored.homeTeamId, stored.awayTeamId], ["void", "p35-home", "p35-away"]);
});

test("program competition count is capped at creation so the list stays loadable", async () => {
  const batch = db.batch();
  for (let i = 0; i < 100; i += 1) {
    batch.set(db.doc(`organizations/${scope.orgId}/competitions/p35-bulk-${i}`), {
      schemaVersion: 2, orgId: scope.orgId, competitionId: `p35-bulk-${i}`, programId: scope.programId, name: `Bulk ${i}`, format: "league",
      seasonId: scope.seasonId, divisionId: scope.divisionId, teamIds: teams, state: "active", revision: 1, draftRules: rules, activeRules: null,
    });
  }
  await batch.commit();
  await domain(saveRules("p35-manager", 0), "COMPETITION_LIMIT");
  assert.equal((await call("p35-manager", "listCompetitions", { orgId: scope.orgId, programId: scope.programId })).competitions.length, 100);
  // Existing competitions remain editable at the cap.
  assert.equal((await saveRules("p35-manager", 1, { confirm: false }, "p35-bulk-0")).revision, 2);
});

test("voiding a final releases the match so its type can change", async () => {
  await saveRules("p35-manager", 0);
  await finalize("p35-staff", 0, played(2, 1));
  const edit = (expectedRevision) => call("p35-manager", "mutateEventSchedule", {
    requestId: `p35-${++seq}`, eventId: "p35-match", expectedRevision, action: "edit", patch: { type: "practice" }, reason: "Wrong type",
  });
  await domain(edit(1), "RESULT_RECORDED");
  await correct("p35-staff", 1, { ...played(null, null), outcome: "void" }, "Not a competition match");
  assert.equal((await db.doc(`events/p35-match/competitionResults/${competitionId}`).get()).exists, false);
  await edit(1);
  const event = (await db.doc("events/p35-match").get()).data();
  assert.deepEqual([event.type, event.homeTeamId, event.awayTeamId], ["practice", null, null]);
  // A void finalized directly never blocks the event either.
  await finalize("p35-staff", 0, { ...played(null, null), outcome: "void" }, { eventId: "p35-cancelled" });
  assert.equal((await db.doc(`events/p35-cancelled/competitionResults/${competitionId}`).get()).exists, false);
});
