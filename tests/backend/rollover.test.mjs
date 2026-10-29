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

const orgId = "r12-org";
const programId = "r12-program";
const sourceSeasonId = "r12-fall";
const users = ["r12-admin", "r12-admin-2", "r12-staff", "r12-coach", "r12-revoked", "r12-foreign", "r12-off-admin"];
const hub = `http://${process.env.FIREBASE_EMULATOR_HUB ?? "127.0.0.1:4400"}`;
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
const target = (name) => ({ name, startsOn: "2027-03-01", endsOn: "2027-06-30" });
const input = (name, excludedTeamIds = ["r12-t000"]) => ({ orgId, sourceSeasonId, target: target(name), excludedTeamIds });
const commit = (uid, preview, name, excluded) =>
  call(uid, "commitRollover", { requestId: `r12-${++seq}`, ...input(name, excluded), previewHash: preview.previewHash });
const triggers = async (enabled) => {
  const response = await fetch(`${hub}/functions/${enabled ? "enable" : "disable"}BackgroundTriggers`, { method: "PUT" });
  assert.equal(response.ok, true, `Could not ${enabled ? "enable" : "disable"} background triggers`);
};
const teamId = (n) => `r12-t${String(n).padStart(3, "0")}`;

async function listAll(kind) {
  const items = [];
  let cursor = null;
  do {
    const page = await call("r12-admin", "listOrganizationHierarchy", { orgId, kind, programId, pageSize: 50, ...(cursor ? { cursor } : {}) });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}
async function snapshot(paths) {
  const docs = await db.getAll(...paths.map((path) => db.doc(path)));
  return docs.map((doc) => [doc.ref.path, doc.data()]);
}
const sourcePaths = () => [
  `organizations/${orgId}/seasons/${sourceSeasonId}`,
  ...["r12-d1", "r12-d2", "r12-d3"].map((id) => `organizations/${orgId}/divisions/${id}`),
  ...Array.from({ length: 205 }, (_, n) => `teams/${teamId(n)}`),
  `teamMembers/${teamId(1)}_r12-coach`, `teams/${teamId(1)}/roster/r12-p1`,
  `organizations/${orgId}/participants/r12-p1/guardians/r12-guardian`, "events/r12-event",
];

before(async () => {
  admin = adminApp({ projectId });
  db = getFirestore(admin);
  worker = require("./lib/seasons/rollover.js");
  for (const uid of users) {
    const app = initializeApp({ projectId, apiKey: "demo-key" }, uid);
    apps[uid] = app;
    connectAuthEmulator(getAuth(app), "http://127.0.0.1:9099", { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), "127.0.0.1", 5001);
    await adminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password: "SyntheticPassword123!" }).catch(() => {});
    await db.doc(`users/${uid}`).set({ uid, appRole: "user" });
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, "SyntheticPassword123!");
  }
  await db.recursiveDelete(db.collection(`organizations/${orgId}/rolloverJobs`));
  const stale = await db.collection("teams").where("orgId", "==", orgId).get();
  for (const doc of stale.docs) if (doc.data().rolloverJobId) await doc.ref.delete();
  for (const path of ["seasons", "divisions"]) {
    const rows = await db.collection(`organizations/${orgId}/${path}`).get();
    for (const doc of rows.docs) if (doc.data().rolloverJobId) await doc.ref.delete();
  }
  let batch = db.batch();
  batch.set(db.doc(`organizations/${orgId}`), { ...meta(), name: "Synthetic league", timeZone: "America/Chicago", features: { organizationV2: true, rollover: true } });
  batch.set(db.doc("organizations/r12-foreign-org"), { ...meta(), name: "Foreign league", timeZone: "UTC", features: { organizationV2: true, rollover: true } });
  batch.set(db.doc("organizations/r12-off"), { ...meta(), name: "Disabled league", timeZone: "UTC", features: { organizationV2: true } });
  batch.set(db.doc(`organizations/${orgId}/programs/${programId}`), { ...meta(), orgId, name: "Youth Soccer", sportCode: "soccer" });
  // The finished source season is archived; rollover still reads it.
  batch.set(db.doc(`organizations/${orgId}/seasons/${sourceSeasonId}`), { ...meta(), status: "archived", orgId, programId, name: "Fall 2026", startsOn: "2026-09-01", endsOn: "2026-11-30" });
  batch.set(db.doc(`organizations/${orgId}/divisions/r12-d1`), { ...meta(), orgId, programId, seasonId: sourceSeasonId, name: "U10", ageBandLabel: "Under 10" });
  batch.set(db.doc(`organizations/${orgId}/divisions/r12-d2`), { ...meta(), orgId, programId, seasonId: sourceSeasonId, name: "U12", ageBandLabel: null });
  batch.set(db.doc(`organizations/${orgId}/divisions/r12-d3`), { ...meta(), status: "archived", orgId, programId, seasonId: sourceSeasonId, name: "Retired", ageBandLabel: null });
  batch.set(db.doc(`organizations/${orgId}/members/r12-admin`), { ...meta(), orgId, roles: ["orgAdmin"], programIds: [] });
  batch.set(db.doc(`organizations/${orgId}/members/r12-admin-2`), { ...meta(), orgId, roles: ["orgAdmin"], programIds: [] });
  batch.set(db.doc(`organizations/${orgId}/members/r12-staff`), { ...meta(), orgId, roles: ["programStaff"], programIds: [programId] });
  batch.set(db.doc(`organizations/${orgId}/members/r12-revoked`), { ...meta(), status: "revoked", orgId, roles: ["orgAdmin"], programIds: [] });
  batch.set(db.doc("organizations/r12-foreign-org/members/r12-foreign"), { ...meta(), orgId: "r12-foreign-org", roles: ["orgAdmin"], programIds: [] });
  batch.set(db.doc("organizations/r12-off/members/r12-off-admin"), { ...meta(), orgId: "r12-off", roles: ["orgAdmin"], programIds: [] });
  await batch.commit();
  // 202 active teams in active divisions, two archived teams and one in an archived division.
  batch = db.batch();
  for (let n = 0; n < 205; n++) {
    const divisionId = n === 204 ? "r12-d3" : n % 2 ? "r12-d2" : "r12-d1";
    batch.set(db.doc(`teams/${teamId(n)}`), { ...meta(), status: n === 202 || n === 203 ? "archived" : "active", orgId, programId,
      seasonId: sourceSeasonId, divisionId, name: `Team ${n}`, externalId: `ext-${n}`, sport: "soccer", inviteCode: null });
  }
  await batch.commit();
  batch = db.batch();
  batch.set(db.doc(`teamMembers/${teamId(1)}_r12-coach`), { ...meta(), orgId, teamId: teamId(1), userId: "r12-coach", roles: ["coach"] });
  batch.set(db.doc(`teams/${teamId(1)}/roster/r12-p1`), { ...meta(), orgId, teamId: teamId(1), participantId: "r12-p1" });
  batch.set(db.doc(`organizations/${orgId}/participants/r12-p1/guardians/r12-guardian`), { ...meta(), orgId, participantId: "r12-p1", uid: "r12-guardian" });
  batch.set(db.doc("events/r12-event"), { ...meta(), orgId, programId, seasonId: sourceSeasonId, teamId: teamId(1), teamIds: [teamId(1)], title: "Synthetic", type: "practice" });
  await batch.commit();
});

after(async () => {
  await triggers(true).catch(() => {});
  await Promise.all(Object.values(apps).map((app) => deleteApp(app)));
  if (admin) await deleteAdmin(admin);
});

test("rollover callables require a live organization administrator in the same tenant", async () => {
  for (const uid of ["r12-staff", "r12-coach", "r12-revoked", "r12-foreign"]) {
    await deny(call(uid, "previewRollover", input("Denied")));
    await deny(call(uid, "commitRollover", { requestId: `r12-${++seq}`, ...input("Denied"), previewHash: "0".repeat(64) }));
    await deny(call(uid, "resumeRollover", { requestId: `r12-${++seq}`, orgId, jobId: "missing" }));
    await deny(call(uid, "listRolloverJobs", { orgId }));
  }
  await domain(call("r12-off-admin", "previewRollover", { ...input("Off"), orgId: "r12-off" }), "ROLLOVER_DISABLED");
  await assert.rejects(call("r12-admin", "previewRollover", input("Bad", ["r12-not-in-season"])), { code: "functions/invalid-argument" });
});

test("preview lists exclusions and never-copied records; a source edit rejects the stale preview", async () => {
  const preview = await call("r12-admin", "previewRollover", input("Spring 2027"));
  assert.deepEqual(preview.counts, { divisions: 2, excludedDivisions: 1, teams: 201, excludedTeams: 4 });
  const reasons = Object.fromEntries(preview.teams.filter((row) => !row.included).map((row) => [row.id, row.reason]));
  assert.deepEqual(reasons, { [teamId(0)]: "deselected", [teamId(202)]: "archived", [teamId(203)]: "archived", [teamId(204)]: "divisionArchived" });
  for (const kind of ["staffAssignments", "teamEnrollments", "guardianLinks", "messages", "events", "reports"]) assert.ok(preview.notCopied.includes(kind));
  assert.equal(preview.source.status, "archived");
  const again = await call("r12-admin", "previewRollover", input("Spring 2027"));
  assert.equal(again.previewHash, preview.previewHash);
  assert.notEqual((await call("r12-admin", "previewRollover", input("Spring 2027", []))).previewHash, preview.previewHash);

  await db.doc(`teams/${teamId(5)}`).update({ name: "Renamed", revision: 2 });
  await domain(commit("r12-admin", preview, "Spring 2027"), "ROLLOVER_PREVIEW_CHANGED");
  assert.equal((await db.collection(`organizations/${orgId}/rolloverJobs`).get()).size, 0);
});

test("a rollover interrupted after its first chunk resumes without duplicates and preserves history", async () => {
  await triggers(false);
  try {
    const outboxBefore = (await db.collection(`organizations/${orgId}/outbox`).count().get()).data().count;
    const history = await snapshot(sourcePaths());
    const preview = await call("r12-admin", "previewRollover", input("Spring 2027"));
    const { job } = await commit("r12-admin", preview, "Spring 2027");
    assert.equal(job.state, "queued");
    assert.equal(job.chunkCount, 3);

    await assert.rejects(worker.runRolloverJob(orgId, job.jobId, {
      afterChunk: async (index) => { if (index === 0) throw new Error("simulated crash"); },
    }), /simulated crash/);
    let row = (await db.doc(`organizations/${orgId}/rolloverJobs/${job.jobId}`).get()).data();
    assert.equal(row.state, "running");
    assert.equal(row.nextChunk, 1);
    assert.deepEqual(row.created, { divisions: 2, teams: 98 });

    // Partial progress is visible to administrators, while the target stays hidden and closed to writes.
    const listed = await call("r12-admin", "listRolloverJobs", { orgId });
    assert.equal(listed.items[0].completedChunks, 1);
    const seasons = await call("r12-admin", "listOrganizationHierarchy", { orgId, kind: "season", programId });
    assert.equal(seasons.items.some((season) => season.id === job.targetSeasonId), false);
    for (const kind of ["team", "division"]) {
      const items = await listAll(kind);
      assert.ok(items.length > 0);
      assert.equal(items.some((item) => item.seasonId === job.targetSeasonId), false, kind);
    }
    const firstDivision = (await db.collection(`organizations/${orgId}/divisions`).where("seasonId", "==", job.targetSeasonId).limit(1).get()).docs[0];
    await domain(call("r12-admin", "saveTeam", { requestId: `r12-${++seq}`, orgId, teamId: null, expectedRevision: 0,
      fields: { name: "Early", programId, seasonId: job.targetSeasonId, divisionId: firstDivision.id, status: "active" } }), "ROLLOVER_IN_PROGRESS");
    await domain(call("r12-admin", "archiveSeason", { requestId: `r12-${++seq}`, orgId, seasonId: job.targetSeasonId, status: "active", expectedRevision: 1 }), "ROLLOVER_IN_PROGRESS");

    // Retrying the commit with a new request ID returns the same job; the live lease keeps a second worker out.
    const retried = await commit("r12-admin", preview, "Spring 2027");
    assert.equal(retried.job.jobId, job.jobId);
    assert.equal((await worker.runRolloverJob(orgId, job.jobId)).state, "busy");

    await db.doc(`organizations/${orgId}/rolloverJobs/${job.jobId}`).update({ leaseExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    const reconciled = await worker.reconcilePendingRollovers();
    assert.ok(reconciled.completed >= 1);
    row = (await db.doc(`organizations/${orgId}/rolloverJobs/${job.jobId}`).get()).data();
    assert.equal(row.state, "complete");
    assert.equal(row.attempts, 2);
    assert.deepEqual(row.created, { divisions: 2, teams: 201 });
    assert.deepEqual(row.reconciled, { divisions: 2, teams: 201 });

    const targetTeams = await db.collection("teams").where("seasonId", "==", job.targetSeasonId).get();
    assert.equal(targetTeams.size, 201);
    const previous = new Set(targetTeams.docs.map((doc) => doc.data().previousTeamId));
    assert.equal(previous.size, 201);
    assert.equal(previous.has(teamId(0)), false);
    const divisions = await db.collection(`organizations/${orgId}/divisions`).where("seasonId", "==", job.targetSeasonId).get();
    assert.deepEqual(divisions.docs.map((doc) => doc.data().previousDivisionId).sort(), ["r12-d1", "r12-d2"]);
    const divisionIds = new Set(divisions.docs.map((doc) => doc.id));
    for (const doc of targetTeams.docs) {
      const team = doc.data();
      assert.equal(team.inviteCode, null);
      assert.equal(team.orgId, orgId);
      assert.ok(divisionIds.has(team.divisionId));
      assert.notEqual(doc.id, team.previousTeamId);
    }
    // No staff, enrollment, guardian, event or notification carries forward.
    const carried = targetTeams.docs.find((doc) => doc.data().previousTeamId === teamId(1));
    assert.equal((await db.doc(`teamMembers/${carried.id}_r12-coach`).get()).exists, false);
    assert.equal((await db.collection(`teams/${carried.id}/roster`).get()).size, 0);
    assert.equal((await db.collection("teamMembers").where("teamId", "==", carried.id).get()).size, 0);
    assert.equal((await db.collection("events").where("seasonId", "==", job.targetSeasonId).get()).size, 0);
    assert.equal((await db.collection(`organizations/${orgId}/outbox`).count().get()).data().count, outboxBefore);

    const season = (await db.doc(`organizations/${orgId}/seasons/${job.targetSeasonId}`).get()).data();
    assert.equal(season.status, "draft");
    assert.equal(season.rolloverState, "complete");
    assert.equal(season.previousSeasonId, sourceSeasonId);
    const visible = await call("r12-admin", "listOrganizationHierarchy", { orgId, kind: "season", programId });
    assert.ok(visible.items.some((item) => item.id === job.targetSeasonId));
    assert.deepEqual(await snapshot(sourcePaths()), history);
    // A repeated run is a no-op for a complete job.
    assert.equal((await worker.runRolloverJob(orgId, job.jobId)).state, "complete");
  } finally {
    await triggers(true);
  }
});

test("revoking the running administrator stops the job visibly until another administrator resumes it", async () => {
  await triggers(false);
  try {
    const preview = await call("r12-admin-2", "previewRollover", input("Summer 2027"));
    const { job } = await commit("r12-admin-2", preview, "Summer 2027");
    const outcome = await worker.runRolloverJob(orgId, job.jobId, {
      afterChunk: async (index) => {
        if (index === 0) await db.doc(`organizations/${orgId}/members/r12-admin-2`).update({ status: "revoked" });
      },
    });
    assert.equal(outcome.state, "failed");
    const failed = (await call("r12-admin", "listRolloverJobs", { orgId })).items.find((item) => item.jobId === job.jobId);
    assert.equal(failed.failure.code, "ROLLOVER_ACCESS_REVOKED");
    assert.equal(failed.completedChunks, 1);
    await deny(call("r12-admin-2", "resumeRollover", { requestId: `r12-${++seq}`, orgId, jobId: job.jobId }));
    const resumed = await call("r12-admin", "resumeRollover", { requestId: `r12-${++seq}`, orgId, jobId: job.jobId });
    assert.equal(resumed.job.state, "queued");
    await domain(call("r12-admin", "resumeRollover", { requestId: `r12-${++seq}`, orgId, jobId: job.jobId }), "ROLLOVER_NOT_FAILED");
    assert.equal((await worker.runRolloverJob(orgId, job.jobId)).state, "complete");
    const row = (await db.doc(`organizations/${orgId}/rolloverJobs/${job.jobId}`).get()).data();
    assert.equal(row.actorUid, "r12-admin");
    assert.deepEqual(row.reconciled, { divisions: 2, teams: 201 });
    assert.equal((await db.collection("teams").where("seasonId", "==", job.targetSeasonId).get()).size, 201);
  } finally {
    await db.doc(`organizations/${orgId}/members/r12-admin-2`).update({ status: "active" });
    await triggers(true);
  }
});

test("a committed rollover runs through the job trigger", async () => {
  const preview = await call("r12-admin", "previewRollover", input("Autumn 2027", Array.from({ length: 200 }, (_, n) => teamId(n))));
  assert.equal(preview.counts.teams, 2);
  const { job } = await commit("r12-admin", preview, "Autumn 2027", Array.from({ length: 200 }, (_, n) => teamId(n)));
  const deadline = Date.now() + 120000;
  for (;;) {
    const row = (await db.doc(`organizations/${orgId}/rolloverJobs/${job.jobId}`).get()).data();
    if (row.state === "complete") break;
    if (Date.now() > deadline) throw new Error(`Rollover did not complete (${row.state}).`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal((await db.collection("teams").where("seasonId", "==", job.targetSeasonId).get()).size, 2);
});
