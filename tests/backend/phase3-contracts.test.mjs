import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertFails,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, writeBatch } from "firebase/firestore";
import phase3 from "../../shared/phase3.ts";
import {
  phase3IsolationFixture,
  projectId,
  requireEmulators,
} from "./fixtures.mjs";

const {
  assertExpectedRevision,
  assertImmutablePhase3Scope,
  decodeCompetitionSides,
  decodeParticipantRef,
  decodePhase3Mutation,
  resolvePhase3Capabilities,
} = phase3;

requireEmulators();

test("canonical competition sides use one shared event and explicit same-tenant teams", () => {
  const event = phase3IsolationFixture.records["events/p3-shared-match"];
  const teams = {
    "p3-team-home": phase3IsolationFixture.parentsA,
    "p3-team-away": phase3IsolationFixture.parentsA,
  };
  assert.deepEqual(decodeCompetitionSides(event, teams), {
    home: { teamId: "p3-team-home" },
    away: { teamId: "p3-team-away" },
  });
  for (const patch of [
    { type: "practice" },
    { teamIds: ["p3-team-home"] },
    { teamIds: ["p3-team-home", "p3-team-away", "p3-team-third"] },
    { homeTeamId: "p3-team-away" },
    { awayTeamId: "p3-team-home" },
    { awayTeamId: "p3-team-foreign" },
  ]) {
    assert.throws(() => decodeCompetitionSides({ ...event, ...patch }, teams));
  }
  assert.throws(() =>
    decodeCompetitionSides(event, {
      ...teams,
      "p3-team-away": phase3IsolationFixture.parentsB,
    }),
  );
});

test("participant references cannot substitute account or guardian uids", () => {
  assert.deepEqual(
    decodeParticipantRef({ orgId: "p3-org-a", participantId: "p3-participant-a" }),
    { orgId: "p3-org-a", participantId: "p3-participant-a" },
  );
  for (const value of [
    { orgId: "p3-org-a", participantId: "p3-guardian-a", uid: "p3-guardian-a" },
    { orgId: "p3-org-a", userId: "p3-guardian-a" },
    { orgId: "p3-org-a", participantId: "" },
    { orgId: "p3-org-b", participantId: "p3-participant-a" },
  ]) {
    assert.throws(() => decodeParticipantRef(value, "p3-org-a"));
  }
});

test("phase 3 mutation envelopes reject stale revisions and immutable-scope changes", () => {
  const decoded = decodePhase3Mutation({
    requestId: "p3-request-1",
    orgId: "p3-org-a",
    resourceId: "p3-shared-match",
    expectedRevision: 3,
    payload: { participantId: "p3-participant-a" },
  });
  assert.equal(decoded.expectedRevision, 3);
  assert.doesNotThrow(() => assertExpectedRevision(3, 3));
  assert.throws(
    () => assertExpectedRevision(4, 3),
    (error) => error.code === "STALE_REVISION" && error.currentRevision === 4,
  );
  const scope = {
    orgId: "p3-org-a",
    programId: "p3-program-a",
    seasonId: "p3-season-a",
    eventId: "p3-shared-match",
    teamId: "p3-team-home",
  };
  assert.doesNotThrow(() => assertImmutablePhase3Scope(scope, { ...scope }));
  for (const field of Object.keys(scope)) {
    assert.throws(() =>
      assertImmutablePhase3Scope(scope, { ...scope, [field]: `changed-${field}` }),
    );
  }
});

test("named capabilities remain scoped and revocation removes coaching authority", () => {
  const scope = {
    orgId: "p3-org-a",
    programId: "p3-program-a",
    teamId: "p3-team-home",
  };
  assert.deepEqual(
    resolvePhase3Capabilities(scope, phase3IsolationFixture.actors.coachParent),
    [
      "coaching.manage",
      "playingTime.manage",
      "practicePlans.manage",
      "reports.viewTeam",
      "results.propose",
      "volunteers.manage",
    ],
  );
  assert.deepEqual(
    resolvePhase3Capabilities(scope, phase3IsolationFixture.actors.orgAdmin),
    [
      "competition.manage",
      "practiceResources.manage",
      "reports.viewOrganization",
      "results.finalize",
      "rollover.manage",
    ],
  );
  assert.deepEqual(
    resolvePhase3Capabilities(scope, phase3IsolationFixture.actors.programStaff),
    [
      "competition.manage",
      "practiceResources.manage",
      "reports.viewOrganization",
      "results.finalize",
    ],
  );
  assert.deepEqual(
    resolvePhase3Capabilities(
      { ...scope, programId: "p3-program-other" },
      phase3IsolationFixture.actors.programStaff,
    ),
    [],
  );
  assert.deepEqual(
    resolvePhase3Capabilities(scope, phase3IsolationFixture.actors.revokedCoach),
    [],
  );
  assert.deepEqual(
    resolvePhase3Capabilities(scope, phase3IsolationFixture.actors.guardianA),
    [],
  );
  assert.deepEqual(
    resolvePhase3Capabilities(
      { ...scope, orgId: "p3-org-b" },
      phase3IsolationFixture.actors.coachParent,
    ),
    [],
  );
});

let env;
const dbFor = (uid) =>
  uid === null
    ? env.unauthenticatedContext().firestore()
    : env.authenticatedContext(uid).firestore();

before(async () => {
  env = await initializeTestEnvironment({
    projectId,
    firestore: {
      host: "127.0.0.1",
      port: 8080,
      rules: readFileSync("firestore.rules", "utf8"),
    },
  });
});

after(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    const batch = writeBatch(db);
    for (const [path, data] of Object.entries(phase3IsolationFixture.records)) {
      batch.set(doc(db, path), data);
    }
    await batch.commit();
  });
});

test("new private and derived paths are denied by default for every actor", async () => {
  const paths = [
    "events/p3-shared-match/coaching/p3-team-home",
    "events/p3-shared-match/coaching/p3-team-home/notes/note-a",
    "events/p3-shared-match/lineupViews/p3-team-home",
    "events/p3-shared-match/playSessions/p3-team-home",
    "events/p3-shared-match/playSessions/p3-team-home/actions/action-a",
    "events/p3-shared-match/volunteerSlots/slot-a",
    "events/p3-shared-match/volunteerSlots/slot-a/claims/p3-guardian-a",
    "events/p3-shared-match/rideRequests/request-a",
    "events/p3-shared-match/rideArrangements/arrangement-a",
    "events/p3-shared-match/practicePlans/p3-team-home",
    "organizations/p3-org-a/competitions/competition-a",
    "organizations/p3-org-a/competitions/competition-a/results/p3-shared-match",
    "organizations/p3-org-a/competitions/competition-a/resultHistory/op-a",
    "organizations/p3-org-a/competitions/competition-a/generations/gen-a",
    "organizations/p3-org-a/competitions/competition-a/bracketNodes/node-a",
    "organizations/p3-org-a/reportRuns/report-a",
    "organizations/p3-org-a/rolloverJobs/job-a",
    "organizations/p3-org-a/practiceResources/resource-a",
  ];
  for (const uid of [
    null,
    "p3-org-admin",
    "p3-coach-parent",
    "p3-guardian-a",
    "p3-guardian-b",
    "p3-revoked-coach",
    "p3-outsider",
  ]) {
    const db = dbFor(uid);
    for (const path of paths) {
      await assertFails(getDoc(doc(db, path)));
      await assertFails(setDoc(doc(db, path), { orgId: "p3-org-a", revision: 1 }));
    }
  }
});

test("cross-tenant and private fixture records remain server-only", async () => {
  for (const uid of [null, "p3-coach-parent", "p3-guardian-a", "p3-org-admin"]) {
    const db = dbFor(uid);
    for (const path of [
      "organizations/p3-org-b/participants/p3-participant-b",
      "organizations/p3-org-b/participants/p3-participant-b/private/profile",
      "organizations/p3-org-b/participants/p3-participant-b/guardians/p3-guardian-b",
      "teams/p3-team-foreign/roster/p3-participant-b",
    ]) {
      await assertFails(getDoc(doc(db, path)));
      await assertFails(setDoc(doc(db, path), { orgId: "p3-org-a" }));
    }
  }
});
