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

const orgId = "r10-org";
const scope = { orgId, programId: "r10-program", seasonId: "r10-season", divisionId: null };
const users = ["r10-admin", "r10-staff", "r10-other-staff", "r10-coach", "r10-captain", "r10-revoked", "r10-foreign"];
let admin;
let db;
let worker;
let seq = 0;
const apps = {};
const call = async (uid, name, data) => (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const deny = (promise) => assert.rejects(promise, { code: "functions/permission-denied" });
const meta = () => ({ schemaVersion: 2, revision: 1, status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
const ts = (value) => Timestamp.fromDate(new Date(value));
const runPath = (runId) => `organizations/${orgId}/reportRuns/${runId}`;
const march = { kind: "attendance", programId: scope.programId, seasonId: scope.seasonId, teamId: null, fromDate: "2026-03-01", toDate: "2026-03-31" };
const request = (uid, filters) => call(uid, "requestReport", { requestId: `r10-${++seq}`, orgId, filters });
/** Drives the worker in-process; a concurrent trigger delivery converges on the same complete run. */
async function built(runId) {
  await worker.buildReport(orgId, runId);
  return settled(runId);
}

// Trigger delivery in the emulator can queue behind other suites' writes, so waits are generous.
async function settled(runId, predicate = (run) => run.state === "complete" || run.state === "failed", timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = (await db.doc(runPath(runId)).get()).data();
    if (run && predicate(run)) return run;
    if (Date.now() > deadline) throw new Error(`Report ${runId} did not settle (${run?.state}).`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function event(id, fields) {
  return [`events/${id}`, {
    ...meta(), ...scope, title: `Synthetic ${id}`, type: "practice", teamId: fields.teamIds[0], timeZone: "America/New_York",
    status: "completed", publicationState: "published", publicationOperationId: null, deletedAt: null, scheduleVersion: 1, ...fields,
  }];
}
const completed = { rosterSnapshot: { schemaVersion: 2, capturedRevision: 2, scheduleVersion: 1, participantCount: 0, eligibleCount: 0 } };
/** Snapshot rows and attendance for one event: [participantId, eligibleTeamIds, allTeamIds, status | null, scheduleVersion]. */
function roster(batch, eventId, rows) {
  for (const [participantId, eligible, teamIds, status, version = 1] of rows) {
    batch.set(db.doc(`events/${eventId}/rosterSnapshots/${participantId}`), {
      schemaVersion: 2, orgId, eventId, participantId, displayName: `Synthetic ${participantId}`, teamIds, capturedRevision: 2,
      enrollments: teamIds.map((teamId) => ({ teamId, eligible: eligible.includes(teamId), status: eligible.includes(teamId) ? "active" : "removed" })),
      eligible: eligible.length > 0,
    });
    if (status) {
      batch.set(db.doc(`events/${eventId}/attendance/${participantId}`), {
        schemaVersion: 2, orgId, eventId, participantId, status, scheduleVersion: version, revision: 1, teamId: teamIds[0],
      });
    }
  }
}

before(async () => {
  admin = adminApp({ projectId });
  db = getFirestore(admin);
  worker = require("./lib/reports/runs.js");
  for (const uid of users) {
    const app = initializeApp({ projectId, apiKey: "demo-key" }, uid);
    apps[uid] = app;
    connectAuthEmulator(getAuth(app), "http://127.0.0.1:9099", { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), "127.0.0.1", 5001);
    await adminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password: "SyntheticPassword123!" }).catch(() => {});
    await db.doc(`users/${uid}`).set({ uid, appRole: "user" });
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, "SyntheticPassword123!");
  }
  await db.recursiveDelete(db.collection(`organizations/${orgId}/reportRuns`));
  let batch = db.batch();
  batch.set(db.doc(`organizations/${orgId}`), { ...meta(), name: "Synthetic league", timeZone: "America/New_York", features: { organizationV2: true, reports: true } });
  batch.set(db.doc("organizations/r10-foreign-org"), { ...meta(), name: "Foreign league", timeZone: "UTC", features: { organizationV2: true, reports: true } });
  batch.set(db.doc(`organizations/${orgId}/programs/${scope.programId}`), { ...meta(), orgId, name: "Program" });
  batch.set(db.doc(`organizations/${orgId}/programs/r10-program-2`), { ...meta(), orgId, name: "Other program" });
  batch.set(db.doc(`organizations/${orgId}/seasons/${scope.seasonId}`), { ...meta(), orgId, programId: scope.programId, name: "Season" });
  batch.set(db.doc(`organizations/${orgId}/members/r10-admin`), { ...meta(), orgId, roles: ["orgAdmin"], programIds: [] });
  batch.set(db.doc(`organizations/${orgId}/members/r10-staff`), { ...meta(), orgId, roles: ["programStaff"], programIds: [scope.programId] });
  batch.set(db.doc(`organizations/${orgId}/members/r10-other-staff`), { ...meta(), orgId, roles: ["programStaff"], programIds: ["r10-program-2"] });
  batch.set(db.doc("organizations/r10-foreign-org/members/r10-foreign"), { ...meta(), orgId: "r10-foreign-org", roles: ["orgAdmin"], programIds: [] });
  batch.set(db.doc(`organizations/${orgId}/seasons/r10-year`), { ...meta(), orgId, programId: scope.programId, name: "Year season" });
  for (const [teamId, name] of [["r10-a", "Team A"], ["r10-b", "Team B"]]) batch.set(db.doc(`teams/${teamId}`), { ...meta(), ...scope, name });
  batch.set(db.doc("teams/r10-c"), { ...meta(), ...scope, seasonId: "r10-year", name: "Team C" });
  const member = (uid, roles, status = "active", teamId = "r10-a") =>
    batch.set(db.doc(`teamMembers/${teamId}_${uid}`), { ...meta(), orgId, teamId, userId: uid, roles, status });
  member("r10-coach", ["coach"]);
  member("r10-captain", ["captain"]);
  member("r10-revoked", ["coach"], "revoked");
  member("r10-coach", ["coach"], "active", "r10-c");

  // Hand-calculated March corpus (America/New_York; the interval spans the spring-forward day).
  const shared = event("r10-e1", { type: "match", teamIds: ["r10-a", "r10-b"], startsAt: ts("2026-03-08T15:00:00Z"), endsAt: ts("2026-03-08T16:30:00Z"), ...completed });
  batch.set(db.doc(shared[0]), shared[1]);
  roster(batch, "r10-e1", [
    ["p1", ["r10-a"], ["r10-a"], "present"], ["p2", ["r10-a"], ["r10-a"], "late"], ["p3", ["r10-a"], ["r10-a"], "absent"],
    ["p4", ["r10-a"], ["r10-a"], "excused"], ["p5", ["r10-a"], ["r10-a"], "unknown"], ["p6", ["r10-a"], ["r10-a"], null],
    // Recorded for an earlier schedule version: missing, not absent.
    ["p9", ["r10-a"], ["r10-a"], "absent", 0],
    // Removed before completion: outside the denominator even with a record.
    ["p7", [], ["r10-a"], "present"],
    ["p8", ["r10-a", "r10-b"], ["r10-a", "r10-b"], "present"], ["q1", ["r10-b"], ["r10-b"], "absent"],
  ]);
  const others = [
    event("r10-e2", { teamIds: ["r10-a"], status: "cancelled", startsAt: ts("2026-03-10T22:00:00Z"), endsAt: ts("2026-03-10T23:00:00Z") }),
    event("r10-e6", { teamIds: ["r10-a"], status: "scheduled", startsAt: ts("2026-03-12T22:00:00Z"), endsAt: ts("2026-03-12T23:00:00Z") }),
    // Mar 31 23:30 local is inside; Apr 1 00:00 local is outside.
    event("r10-e7", { teamIds: ["r10-b"], status: "cancelled", startsAt: ts("2026-04-01T03:30:00Z"), endsAt: ts("2026-04-01T03:45:00Z") }),
    event("r10-e8", { teamIds: ["r10-b"], status: "cancelled", startsAt: ts("2026-04-01T04:00:00Z"), endsAt: ts("2026-04-01T05:00:00Z") }),
    // Restricted records: staged, deleted, other program and foreign organization never enter aggregates.
    event("r10-staged", { teamIds: ["r10-a"], publicationState: "staged", startsAt: ts("2026-03-14T15:00:00Z"), endsAt: ts("2026-03-14T16:00:00Z"), ...completed }),
    event("r10-deleted", { teamIds: ["r10-a"], deletedAt: Timestamp.now(), startsAt: ts("2026-03-15T15:00:00Z"), endsAt: ts("2026-03-15T16:00:00Z"), ...completed }),
    event("r10-other-program", { teamIds: ["r10-a"], programId: "r10-program-2", startsAt: ts("2026-03-16T15:00:00Z"), endsAt: ts("2026-03-16T16:00:00Z"), ...completed }),
    event("r10-foreign", { teamIds: ["r10-a"], orgId: "r10-foreign-org", startsAt: ts("2026-03-17T15:00:00Z"), endsAt: ts("2026-03-17T16:00:00Z"), ...completed }),
  ];
  for (const [path, row] of others) batch.set(db.doc(path), row);
  for (const id of ["r10-staged", "r10-deleted", "r10-other-program", "r10-foreign"]) roster(batch, id, [["p1", ["r10-a"], ["r10-a"], "absent"]]);

  // Facility corpus on the same spring-forward day.
  const facility = `organizations/${orgId}/facilities/r10-f1`;
  batch.set(db.doc(facility), { ...meta(), orgId, name: "Synthetic park", timeZone: "America/New_York" });
  for (const id of ["r10-r1", "r10-r2"]) batch.set(db.doc(`${facility}/resources/${id}`), { ...meta(), orgId, facilityId: "r10-f1", label: id === "r10-r1" ? "Field 1" : "Field 2", sports: ["soccer"], setupMinutes: 0, cleanupMinutes: 0 });
  batch.set(db.doc(`${facility}/resources/r10-r1/availability/1`), { schemaVersion: 2, orgId, facilityId: "r10-f1", resourceId: "r10-r1", revision: 1,
    effectiveFrom: "2026-03-01T00:00:00.000Z", windows: [{ startsAt: "2026-03-08T13:00:00.000Z", endsAt: "2026-03-08T21:00:00.000Z" }] });
  // Superseded history before the version in force at the interval start never contributes.
  batch.set(db.doc(`${facility}/resources/r10-r1/availability/0`), { schemaVersion: 2, orgId, facilityId: "r10-f1", resourceId: "r10-r1", revision: 0,
    effectiveFrom: "2026-02-01T00:00:00.000Z", windows: [{ startsAt: "2026-03-08T05:00:00.000Z", endsAt: "2026-03-09T04:00:00.000Z" }] });
  batch.set(db.doc(`organizations/${orgId}/closures/r10-closure`), { schemaVersion: 2, orgId, facilityId: "r10-f1", resourceIds: ["r10-r1"], status: "applied", revision: 1,
    startsAt: "2026-03-08T19:00:00.000Z", endsAt: "2026-03-08T20:00:00.000Z", reason: "Synthetic maintenance" });
  const booking = (id, resourceId, status, startsAt, endsAt, extra = {}) => {
    const [path, row] = event(id, { teamIds: ["r10-d"], seasonId: "r10-year", status, startsAt: ts(startsAt), endsAt: ts(endsAt), facilityId: "r10-f1", resourceId,
      resourceOccupancy: { startsAt: ts(startsAt), endsAt: ts(endsAt), setupMinutes: 0, cleanupMinutes: 0 }, ...extra });
    batch.set(db.doc(path), row);
  };
  // One canonical shared game, counted once although two teams play it.
  booking("r10-b1", "r10-r1", "completed", "2026-03-08T13:00:00Z", "2026-03-08T14:30:00Z", { type: "match", teamIds: ["r10-d", "r10-e"] });
  booking("r10-b2", "r10-r1", "scheduled", "2026-03-08T14:00:00Z", "2026-03-08T15:00:00Z");
  booking("r10-b3", "r10-r1", "cancelled", "2026-03-08T15:00:00Z", "2026-03-08T16:00:00Z");
  booking("r10-b4", "r10-r1", "scheduled", "2026-03-08T16:00:00Z", "2026-03-08T17:00:00Z", { publicationState: "staged" });
  booking("r10-b5", "r10-r1", "scheduled", "2026-03-08T19:30:00Z", "2026-03-08T20:30:00Z");
  booking("r10-b6", "r10-r1", "completed", "2026-03-08T21:00:00Z", "2026-03-08T22:00:00Z");
  booking("r10-b7", "r10-r2", "completed", "2026-03-08T10:00:00Z", "2026-03-08T11:00:00Z");
  // Starts after the interval ends (00:30 local next day) but its 60-minute setup occupies the last 30 minutes.
  {
    const [path, row] = event("r10-b9", { teamIds: ["r10-d"], seasonId: "r10-year", status: "completed", startsAt: ts("2026-03-09T04:30:00Z"), endsAt: ts("2026-03-09T05:30:00Z"),
      facilityId: "r10-f1", resourceId: "r10-r1", resourceOccupancy: { startsAt: ts("2026-03-09T03:30:00Z"), endsAt: ts("2026-03-09T05:30:00Z"), setupMinutes: 60, cleanupMinutes: 0 } });
    batch.set(db.doc(path), row);
  }
  booking("r10-b8", "r10-r1", "completed", "2026-03-08T17:00:00Z", "2026-03-08T18:00:00Z", { orgId: "r10-foreign-org" });
  await batch.commit();

  // 366-day synthetic scoped run: team C, one practice a week, 6 participants each.
  batch = db.batch();
  let writes = 0;
  const start = Date.parse("2025-10-31T22:00:00Z");
  for (let week = 0; week < 52; week++) {
    for (const offset of [0]) {
      const startsAt = start + (week * 7 + offset) * 86400000;
      const id = `r10-year-${week}-${offset}`;
      const [path, row] = event(id, { teamIds: ["r10-c"], seasonId: "r10-year", startsAt: Timestamp.fromMillis(startsAt), endsAt: Timestamp.fromMillis(startsAt + 3600000), ...completed });
      batch.set(db.doc(path), row);
      roster(batch, id, Array.from({ length: 6 }, (_, i) => [`c${i}`, ["r10-c"], ["r10-c"], ["present", "late", "absent"][i % 3]]));
      writes += 13;
      if (writes > 400) {
        await batch.commit();
        batch = db.batch();
        writes = 0;
      }
    }
  }
  await batch.commit();
});

after(async () => {
  await Promise.all(Object.values(apps).map((app) => deleteApp(app)));
  if (admin) await deleteAdmin(admin);
});

test("organization attendance run matches the hand calculation and excludes restricted records", async () => {
  const { runId, state } = await request("r10-admin", march);
  assert.equal(state, "queued");
  const queued = await call("r10-admin", "getReportRun", { orgId, runId });
  assert.deepEqual(queued.rows, []);
  await built(runId);
  const { run, rows } = await call("r10-admin", "getReportRun", { orgId, runId });
  assert.equal(run.state, "complete");
  // Local March in New York loses one hour to daylight saving.
  assert.deepEqual([run.interval.startsAt, run.interval.endsAt, run.interval.hours], ["2026-03-01T05:00:00.000Z", "2026-04-01T04:00:00.000Z", 743]);
  const s = run.summary;
  assert.deepEqual(s.events, { closed: 1, cancelled: 2, postponed: 0, awaitingClosure: 1, upcoming: 0 });
  // Eligible p1-p6, p8, p9, q1; p6 and p9 are missing; p8 counts once in the shared game.
  assert.deepEqual([s.eligible, s.present, s.late, s.absent, s.excused, s.unknown, s.missing], [9, 2, 1, 2, 1, 1, 2]);
  assert.deepEqual(s.presenceRate, { numerator: 3, denominator: 5, rate: 0.6 });
  assert.deepEqual(s.completionCoverage, { numerator: 6, denominator: 9, rate: 0.6667 });
  assert.deepEqual(rows.map((row) => [row.label, row.eligible, row.present, row.absent, row.missing]), [["Team A", 8, 2, 1, 2], ["Team B", 2, 1, 1, 0]]);
  assert.ok(run.formulas.some((line) => line.startsWith("presenceRate")));
  assert.equal(run.sourceDigest.length, 64);
  assert.equal(JSON.stringify(rows).includes("Synthetic p"), false, "aggregate rows carry no participant names");
});

test("team coaches see only their team, and staff need program scope", async () => {
  const team = { ...march, teamId: "r10-a" };
  const { runId } = await request("r10-coach", team);
  await built(runId);
  const view = await call("r10-coach", "getReportRun", { orgId, runId });
  assert.deepEqual(view.rows.map((row) => row.teamId), ["r10-a"]);
  assert.deepEqual([view.run.summary.eligible, view.run.summary.events.closed], [8, 1]);
  assert.equal((await call("r10-staff", "getReportRun", { orgId, runId })).run.runId, runId);
  await deny(request("r10-coach", march));
  await deny(request("r10-coach", { ...march, teamId: "r10-b" }));
  for (const uid of ["r10-captain", "r10-revoked", "r10-other-staff", "r10-foreign"]) {
    await deny(request(uid, team));
    await deny(call(uid, "getReportRun", { orgId, runId }));
  }
  await deny(request("r10-staff", { kind: "facility", facilityId: "r10-f1", fromDate: "2026-03-08", toDate: "2026-03-08" }));
  const orgRun = await request("r10-staff", march);
  await deny(call("r10-coach", "getReportRun", { orgId, runId: orgRun.runId }));
  const coachList = await call("r10-coach", "listReportRuns", { orgId, teamId: "r10-a" });
  assert.ok(coachList.items.every((item) => item.filters.teamId === "r10-a"));
  await deny(call("r10-coach", "listReportRuns", { orgId }));
  await deny(call("r10-staff", "listReportRuns", { orgId }));
  assert.ok((await call("r10-staff", "listReportRuns", { orgId, programId: scope.programId })).items.length >= 2);
  await deny(call("r10-other-staff", "listReportRuns", { orgId, programId: scope.programId }));
  // Revocation is checked on every read.
  await db.doc("teamMembers/r10-a_r10-coach").update({ status: "revoked" });
  await deny(call("r10-coach", "getReportRun", { orgId, runId }));
  await db.doc("teamMembers/r10-a_r10-coach").update({ status: "active" });
  await assert.rejects(request("r10-admin", { ...march, fromDate: "2026-01-01", toDate: "2027-01-02" }), { code: "functions/invalid-argument" });
});

test("exports serialize only a complete snapshot through the same live grants, neutralizing formulas", async () => {
  const exportOf = (uid, runId) => call(uid, "exportReport", { orgId, runId });
  // A run that never completed has no exportable rows. (A fresh queued run can finish through its trigger before an
  // export call, so the incomplete case uses a failed run whose state cannot change.)
  await db.doc(runPath("r10-export-failed")).set({
    schemaVersion: 2, orgId, runId: "r10-export-failed", kind: "attendance", filters: march, ...scope, teamId: null, facilityId: null,
    state: "failed", attempts: 3, failure: { code: "REPORT_FAILED", message: "Synthetic failure." }, rowCount: 0, completedAttempt: null, requestedAt: Timestamp.now(),
  });
  await assert.rejects(exportOf("r10-admin", "r10-export-failed"), (error) => error.code === "functions/failed-precondition" && error.details?.domainCode === "REPORT_NOT_COMPLETE");
  const queued = await request("r10-admin", march);
  const run = await built(queued.runId);
  // Stored rows may carry more than the allowlisted columns; a spreadsheet formula in a label is neutralized.
  const rowRef = db.doc(`${runPath(queued.runId)}/rows/${String(run.completedAttempt).padStart(2, "0")}-0001`);
  const original = (await rowRef.get()).data();
  await rowRef.update({ label: "=HYPERLINK(\"https://example.test\")", displayName: "Synthetic p1", notes: "Private note", contact: "guardian@example.test" });
  const file = await exportOf("r10-admin", queued.runId);
  assert.equal(file.runId, queued.runId);
  assert.equal(file.rowCount, run.rowCount);
  assert.equal(file.mimeType, "text/csv");
  assert.match(file.fileName, /^team-hangout-attendance-2026-03-01-to-2026-03-31-/);
  for (const line of [`"runId","${queued.runId}"`, '"reportVersion","1"', '"filter.programId","r10-program"', '"filter.teamId",""', '"intervalStartsAt","2026-03-01T05:00:00.000Z"', '"stale","false"']) {
    assert.ok(file.csv.includes(line), line);
  }
  assert.ok(file.csv.includes('"\'=HYPERLINK(""https://example.test"")"'));
  assert.ok(file.csv.includes('"summary","","All teams","9","2","1","2","1","1","2"'));
  assert.ok(!/Synthetic p|Private note|guardian@example/.test(file.csv), "restricted fields never reach the file");
  await rowRef.set(original);

  // Coaches export their own team run only; revoked, captain, other-program and foreign users are denied.
  const teamRun = await request("r10-coach", { ...march, teamId: "r10-a" });
  await built(teamRun.runId);
  assert.equal((await exportOf("r10-coach", teamRun.runId)).rowCount, 1);
  await deny(exportOf("r10-coach", queued.runId));
  for (const uid of ["r10-captain", "r10-revoked", "r10-other-staff", "r10-foreign"]) await deny(exportOf(uid, teamRun.runId));
  await db.doc("teamMembers/r10-a_r10-coach").update({ status: "revoked" });
  await deny(exportOf("r10-coach", teamRun.runId));
  await db.doc("teamMembers/r10-a_r10-coach").update({ status: "active" });

  // A range with no events exports the summary and no rows; a file never disagrees with its snapshot.
  const empty = await request("r10-admin", { ...march, fromDate: "2026-02-01", toDate: "2026-02-02" });
  const emptyRun = await built(empty.runId);
  const emptyFile = await exportOf("r10-admin", empty.runId);
  assert.equal(emptyFile.rowCount, emptyRun.rowCount);
  assert.ok(emptyFile.csv.includes('"rowKind","teamId","team"'));
  await db.doc(runPath(empty.runId)).update({ rowCount: emptyRun.rowCount + 1 });
  await assert.rejects(exportOf("r10-admin", empty.runId), (error) => error.code === "functions/unavailable" && error.details?.domainCode === "REPORT_EXPORT_UNAVAILABLE");
});

test("a correction marks the snapshot stale and a rebuild produces a new run without editing the old one", async () => {
  const { runId } = await request("r10-admin", march);
  const first = await built(runId);
  // Roster changes after completion do not move frozen denominators: a rebuild with unchanged sources verifies.
  await db.doc("teams/r10-b/roster/p8").set({ schemaVersion: 2, orgId, participantId: "p8", status: "removed" });
  const verify = await call("r10-admin", "rebuildReport", { requestId: `r10-${++seq}`, orgId, runId });
  const verified = await built(verify.runId);
  assert.equal(verified.sourceDigest, first.sourceDigest);
  const old = (await db.doc(runPath(runId)).get()).data();
  assert.deepEqual([old.stale, old.verifiedBy, old.supersededBy], [false, verify.runId, verify.runId]);

  await db.doc("events/r10-e1/attendance/p3").update({ status: "present", revision: 2 });
  const stale = await settled(verify.runId, (run) => run.stale === true);
  assert.equal(stale.staleReason, "attendanceCorrected");
  const rebuilt = await call("r10-admin", "rebuildReport", { requestId: `r10-${++seq}`, orgId, runId: verify.runId });
  const fresh = await built(rebuilt.runId);
  assert.equal(fresh.stale, false);
  assert.deepEqual([fresh.summary.present, fresh.summary.absent, fresh.summary.presenceRate.rate], [3, 1, 0.8]);
  const before = (await db.doc(runPath(verify.runId)).get()).data();
  assert.deepEqual([before.summary.present, before.summary.absent, before.supersededBy], [2, 2, rebuilt.runId]);
  const view = await call("r10-admin", "getReportRun", { orgId, runId: verify.runId });
  assert.equal(view.run.stale, true);
  assert.equal(view.rows.length, 2);
  await db.doc("events/r10-e1/attendance/p3").update({ status: "absent", revision: 3 });
});

test("facility run matches the hand calculation for closures, conflicts, shared games and unknown availability", async () => {
  const { runId } = await request("r10-admin", { kind: "facility", facilityId: "r10-f1", fromDate: "2026-03-08", toDate: "2026-03-08" });
  await built(runId);
  const { run, rows } = await call("r10-admin", "getReportRun", { orgId, runId });
  assert.equal(run.interval.hours, 23);
  const [r1, r2] = rows;
  // 480 scheduled minus 60 closed; b1 union b2 = 120 booked; b6 60 and b9's setup 30 outside; b5 sits in the closure.
  assert.deepEqual([r1.label, r1.availableMinutes, r1.closedMinutes, r1.bookedMinutes, r1.conflictMinutes, r1.outsideAvailabilityMinutes], ["Field 1", 420, 60, 120, 30, 90]);
  assert.deepEqual([r1.bookings, r1.excludedBookings, r1.closureAffectedBookings], [4, 1, 1]);
  assert.deepEqual(r1.utilization, { numerator: 120, denominator: 420, rate: 0.2857 });
  assert.deepEqual([r2.unknownAvailabilityMinutes, r2.unknownAvailabilityBookedMinutes, r2.availableMinutes, r2.utilization.rate], [1380, 60, 0, null]);
  assert.deepEqual([run.summary.availableMinutes, run.summary.bookedMinutes, run.summary.utilization.rate], [420, 120, 0.2857]);
  assert.equal(JSON.stringify({ run, rows }).includes("Synthetic r10"), false, "no event titles in facility reports");

  // A newly applied closure marks covering facility snapshots stale.
  const closure = db.doc(`organizations/${orgId}/closures/r10-closure-2`);
  await closure.set({ schemaVersion: 2, orgId, facilityId: "r10-f1", resourceIds: ["r10-r2"], status: "applied", revision: 1,
    startsAt: "2026-03-08T12:00:00.000Z", endsAt: "2026-03-08T13:00:00.000Z", reason: "Synthetic repair" });
  await db.doc(`organizations/${orgId}/scheduleOperations/closure_r10-closure-2`).set({ schemaVersion: 2, orgId, operationId: "closure_r10-closure-2",
    closureId: "r10-closure-2", action: "facilityClosure", startsAt: "2026-03-08T12:00:00.000Z", endsAt: "2026-03-08T13:00:00.000Z", state: "committed" });
  const stale = await settled(runId, (row) => row.stale === true);
  assert.equal(stale.staleReason, "closureChanged");
  await closure.delete();

  // A lifecycle change appends schedule history, which marks a fresh snapshot stale.
  const second = await request("r10-admin", { kind: "facility", facilityId: "r10-f1", fromDate: "2026-03-08", toDate: "2026-03-08" });
  await built(second.runId);
  await db.doc("events/r10-b6").update({ status: "cancelled", revision: 2 });
  await db.doc("events/r10-b6/scheduleHistory/2").set({ schemaVersion: 2, revision: 2, action: "cancel", previousStatus: "completed", status: "cancelled" });
  const changed = await settled(second.runId, (row) => row.stale === true);
  assert.equal(changed.staleReason, "eventChanged");
  await db.doc("events/r10-b6").update({ status: "completed", revision: 3 });
});

test("partial and abandoned builds never publish rows, and duplicate workers converge", async () => {
  const base = { schemaVersion: 2, orgId, kind: "attendance", filters: { ...march, teamId: "r10-a" }, ...scope, teamId: "r10-a", facilityId: null,
    interval: { fromDate: "2026-03-01", toDate: "2026-03-31", timeZone: "America/New_York", days: 31, startsAt: "2026-03-01T05:00:00.000Z", endsAt: "2026-04-01T04:00:00.000Z", hours: 743 },
    intervalStartsAt: "2026-03-01T05:00:00.000Z", intervalEndsAt: "2026-04-01T04:00:00.000Z", reportVersion: 1, reducerVersion: 1, formulas: [],
    requestedBy: "r10-admin", requestedAt: Timestamp.now(), queuedAt: Timestamp.now(), stale: false, staleReason: null, sourceChangedAt: null,
    supersedes: null, supersededBy: null, failure: null, summary: null, manifest: null, rowCount: 0, sourceDigest: null, completedAttempt: null };
  // A live lease: the trigger leaves it alone and its partial row is not served.
  await db.doc(runPath("r10-held")).set({ ...base, runId: "r10-held", state: "building", attempts: 1, startedAt: Timestamp.now(), leaseExpiresAt: Timestamp.fromMillis(Date.now() + 600000) });
  await db.doc(`${runPath("r10-held")}/rows/01-0001`).set({ attempt: 1, position: 1, kind: "team", teamId: "r10-a", label: "Partial", eligible: 999 });
  // An abandoned build: the trigger claims attempt 2 and only its rows are served.
  await db.doc(runPath("r10-abandoned")).set({ ...base, runId: "r10-abandoned", state: "building", attempts: 1, startedAt: Timestamp.now(), leaseExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
  await db.doc(`${runPath("r10-abandoned")}/rows/01-0001`).set({ attempt: 1, position: 1, kind: "team", teamId: "r10-a", label: "Partial", eligible: 999 });
  const recovered = await built("r10-abandoned");
  assert.deepEqual([recovered.state, recovered.completedAttempt, recovered.summary.eligible], ["complete", 2, 8]);
  const view = await call("r10-admin", "getReportRun", { orgId, runId: "r10-abandoned" });
  assert.deepEqual(view.rows.map((row) => [row.label, row.eligible]), [["Team A", 8]]);
  assert.equal((await db.collection(`${runPath("r10-abandoned")}/rows`).where("attempt", "==", 1).get()).size, 0);
  const held = await call("r10-admin", "getReportRun", { orgId, runId: "r10-held" });
  assert.deepEqual([held.run.state, held.run.summary, held.rows], ["building", null, []]);
  assert.equal((await worker.buildReport(orgId, "r10-held")).state, "busy");
  // Duplicate invocations on a complete run change nothing.
  const again = await worker.buildReport(orgId, "r10-abandoned");
  assert.equal(again.state, "complete");
  assert.equal((await db.doc(runPath("r10-abandoned")).get()).data().completedAttempt, 2);
});

test("a synthetic 366-day team run stays within guardrails and records its read cost", async () => {
  const started = Date.now();
  const { runId } = await request("r10-coach", { ...march, seasonId: "r10-year", teamId: "r10-c", fromDate: "2025-10-30", toDate: "2026-10-30" });
  const run = await built(runId);
  assert.equal(run.state, "complete", run.failure?.message);
  assert.equal(run.interval.days, 366);
  assert.deepEqual([run.manifest.eventsInScope, run.summary.events.closed, run.summary.eligible, run.summary.present], [52, 52, 312, 104]);
  assert.deepEqual(run.summary.presenceRate, { numerator: 208, denominator: 312, rate: 0.6667 });
  // One event page read plus one snapshot and one attendance read per participant-event.
  const reads = run.manifest.eventReads + run.manifest.snapshotReads + run.manifest.attendanceReads;
  assert.equal(reads, 52 + 312 + 312);
  console.log(`366-day team run: ${run.manifest.eventsInScope} events, ${reads} document reads, worker ${run.manifest.durationMs} ms, end-to-end ${Date.now() - started} ms`);
});
