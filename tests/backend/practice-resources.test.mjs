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

// Synthetic fixtures only: every resource below is invented test text with invented rights references.
const users = ["p313-editor", "p313-reviewer", "p313-reviewer2", "p313-staff2", "p313-coach", "p313-revoked", "p313-guardian", "p313-player", "p313-outsider", "p313-foreign"];
let admin;
let db;
let seq = 0;
const apps = {};
const call = async (uid, name, data) => (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const deny = (promise) => assert.rejects(promise, { code: "functions/permission-denied" });
const domain = (promise, domainCode) => assert.rejects(promise, (error) => error.details?.domainCode === domainCode);
const scope = { orgId: "p313-org", programId: "p313-soccer", seasonId: "p313-season", divisionId: "p313-division" };
const meta = () => ({ schemaVersion: 2, revision: 1, status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now() });
const eventId = "p313-practice";
const teamId = "p313-team";
const rid = () => `p313-${++seq}`;
const content = (title, ageMin, ageMax) => ({
  title, objectives: ["Synthetic passing objective"], ageMin, ageMax, durationMinutes: 15, equipment: ["Cones"],
  instructions: `Synthetic original instructions for ${title}.`, safetyNotes: "Synthetic safety reminder: keep spacing.",
});
const rights = (extra = {}) => ({
  origin: "original", owner: "Synthetic league", allowedUses: "Internal coaching use", attribution: null,
  evidence: "Synthetic authorship record SYN-1", licenseUrl: null, expiresAt: null, derivativesAllowed: true, ...extra,
});
const saveResource = (uid, { resourceId = null, expectedRevision = 0, programId = scope.programId, title = "Passing gates", ages = [6, 8], rightsExtra = {}, requestId = rid() } = {}) =>
  call(uid, "savePracticeResource", { requestId, orgId: scope.orgId, resourceId, expectedRevision, payload: { programId, content: content(title, ...ages), rights: rights(rightsExtra) } });
const approve = (uid, resourceId, expectedRevision, extra = {}) =>
  call(uid, "publishPracticeResource", { requestId: rid(), orgId: scope.orgId, resourceId, expectedRevision, payload: { action: "approve", rightsVerified: true, ageSafetyReviewed: true, ...extra } });
const withdraw = (uid, resourceId, expectedRevision) =>
  call(uid, "publishPracticeResource", { requestId: rid(), orgId: scope.orgId, resourceId, expectedRevision, payload: { action: "withdraw", reason: "Synthetic permission ended" } });
const publishNew = async (options = {}) => {
  const saved = await saveResource("p313-editor", options);
  const approved = await approve("p313-reviewer", saved.resourceId, saved.revision);
  return { resourceId: saved.resourceId, revision: approved.revision, version: approved.version };
};
const coachList = (uid, extra = {}) => call(uid, "listPracticeResources", { orgId: scope.orgId, teamId, ...extra });
const plan = (uid, expectedRevision, payload, requestId = rid()) =>
  call(uid, "savePracticePlan", { requestId, orgId: scope.orgId, resourceId: eventId, expectedRevision, payload: { teamId, ...payload } });
const savePlan = (uid, expectedRevision, items, extra = {}, requestId) =>
  plan(uid, expectedRevision, { action: "save", items, householdNote: "Bring water.", privateNote: "", ...extra }, requestId);
const getPlan = (uid, participantId) => call(uid, "getEventPracticePlan", { eventId, teamId, ...(participantId ? { participantId } : {}) });

before(async () => {
  admin = adminApp({ projectId }, "p313-admin-app");
  db = getFirestore(admin);
  for (const uid of users) {
    const app = initializeApp({ projectId, apiKey: "demo-key" }, uid);
    apps[uid] = app;
    connectAuthEmulator(getAuth(app), "http://127.0.0.1:9099", { disableWarnings: true });
    connectFunctionsEmulator(getFunctions(app), "127.0.0.1", 5001);
    connectFirestoreEmulator(clientDb(app), "127.0.0.1", 8080);
    await adminAuth(admin).createUser({ uid, email: `${uid}@example.test`, password: "SyntheticPassword123!" }).catch(() => {});
    await signInWithEmailAndPassword(getAuth(app), `${uid}@example.test`, "SyntheticPassword123!");
  }
});

after(async () => {
  await Promise.all(Object.values(apps).map((app) => deleteApp(app)));
  if (admin) await deleteAdmin(admin);
});

beforeEach(async () => {
  for (const row of (await db.collection(`organizations/${scope.orgId}/practiceResources`).get()).docs) await db.recursiveDelete(row.ref);
  for (const row of (await db.collection(`events/${eventId}/practicePlans`).get()).docs) await db.recursiveDelete(row.ref);
  await db.doc("accountDeletionJobs/p313-editor").delete();
  const batch = db.batch();
  for (const uid of users) batch.set(db.doc(`users/${uid}`), { uid, appRole: "user" });
  batch.set(db.doc(`organizations/${scope.orgId}`), { ...meta(), name: "Synthetic league", features: { organizationV2: true, households: true, practiceResources: true } });
  batch.set(db.doc("organizations/p313-other"), { ...meta(), name: "Other league", features: { organizationV2: true, practiceResources: true } });
  for (const [kind, name] of [["programs", scope.programId], ["programs", "p313-hoops"], ["seasons", scope.seasonId], ["divisions", scope.divisionId]]) {
    batch.set(db.doc(`organizations/${scope.orgId}/${kind}/${name}`), { ...meta(), ...scope, ...(kind === "programs" ? { programId: name, sportCode: name === scope.programId ? "soccer" : "basketball" } : {}), name });
  }
  const staff = (uid, roles, programIds, orgId = scope.orgId) =>
    batch.set(db.doc(`organizations/${orgId}/members/${uid}`), { ...meta(), orgId, roles, programIds });
  staff("p313-editor", ["programStaff"], [scope.programId]);
  staff("p313-reviewer", ["programStaff"], [scope.programId]);
  staff("p313-reviewer2", ["orgAdmin"], []);
  staff("p313-staff2", ["programStaff"], ["p313-hoops"]);
  staff("p313-foreign", ["orgAdmin"], [], "p313-other");
  const reviewer = (uid, programIds) => batch.set(db.doc(`organizations/${scope.orgId}/resourceReviewers/${uid}`), {
    ...meta(), orgId: scope.orgId, userId: uid, programIds, qualification: "Synthetic safeguarding and coaching review",
  });
  reviewer("p313-reviewer", [scope.programId]);
  reviewer("p313-reviewer2", [scope.programId, "p313-hoops"]);
  batch.set(db.doc(`teams/${teamId}`), { ...meta(), ...scope, name: "Synthetic U8" });
  const member = (uid, roles, status = "active") =>
    batch.set(db.doc(`teamMembers/${teamId}_${uid}`), { ...meta(), orgId: scope.orgId, teamId, userId: uid, roles, status });
  member("p313-coach", ["coach"]);
  member("p313-revoked", ["coach"], "revoked");
  member("p313-player", ["player"]);
  batch.set(db.doc(`organizations/${scope.orgId}/participants/p313-a`), { ...meta(), orgId: scope.orgId, displayName: "Synthetic A", kind: "youth", linkedUserId: null });
  batch.set(db.doc(`teams/${teamId}/roster/p313-a`), { ...meta(), orgId: scope.orgId, participantId: "p313-a" });
  batch.set(db.doc(`organizations/${scope.orgId}/participants/p313-a/guardians/p313-guardian`), {
    ...meta(), orgId: scope.orgId, participantId: "p313-a", userId: "p313-guardian", permissions: { viewProfile: true, editProfile: false, viewSchedule: true, respond: true },
  });
  const event = (id, type) => batch.set(db.doc(`events/${id}`), {
    ...meta(), ...scope, title: "Synthetic practice", type, teamId, teamIds: [teamId],
    startsAt: Timestamp.fromDate(new Date("2027-03-20T23:00:00Z")), endsAt: Timestamp.fromDate(new Date("2027-03-21T00:30:00Z")),
    timeZone: "America/Chicago", status: "scheduled", publicationState: "published", publicationOperationId: null, deletedAt: null,
  });
  event(eventId, "practice");
  event("p313-other-event", "match");
  await batch.commit();
});

test("publication needs a designated second reviewer and recorded rights evidence", async () => {
  // Missing rights evidence is rejected before anything is stored.
  await assert.rejects(saveResource("p313-editor", { rightsExtra: { evidence: "" } }), { code: "functions/invalid-argument" });
  await assert.rejects(saveResource("p313-editor", { rightsExtra: { origin: "licensed" } }), { code: "functions/invalid-argument" });
  await domain(saveResource("p313-editor", { rightsExtra: { expiresAt: "2020-01-01T00:00:00.000Z" } }), "PRACTICE_RIGHTS_EXPIRED");
  const saved = await saveResource("p313-editor");
  assert.equal(saved.state, "draft");
  assert.equal(saved.version, 1);
  // Drafts are never selectable by coaches.
  assert.deepEqual((await coachList("p313-coach")).items, []);
  // An editor without a reviewer designation, and a reviewer approving their own edits, are both denied.
  await domain(approve("p313-editor", saved.resourceId, saved.revision), "PRACTICE_REVIEWER_REQUIRED");
  const own = await saveResource("p313-reviewer", { resourceId: saved.resourceId, expectedRevision: saved.revision });
  await domain(approve("p313-reviewer", saved.resourceId, own.revision), "PRACTICE_REVIEWER_CONFLICT");
  await assert.rejects(approve("p313-reviewer2", saved.resourceId, own.revision, { ageSafetyReviewed: false }), { code: "functions/invalid-argument" });
  // Program staff of another program and other tenants cannot review or edit.
  await deny(approve("p313-staff2", saved.resourceId, own.revision));
  await deny(approve("p313-foreign", saved.resourceId, own.revision));
  await deny(saveResource("p313-staff2"));
  const approved = await approve("p313-reviewer2", saved.resourceId, own.revision, { reviewNote: "Synthetic review" });
  assert.equal(approved.state, "published");
  const stored = (await db.doc(`organizations/${scope.orgId}/practiceResources/${saved.resourceId}`).get()).data();
  assert.equal(stored.published.review.reviewerUid, "p313-reviewer2");
  assert.equal(stored.published.rights.evidence, "Synthetic authorship record SYN-1");
  assert.equal(stored.draft, null);
  const version = (await db.doc(`organizations/${scope.orgId}/practiceResources/${saved.resourceId}/versions/1`).get()).data();
  assert.equal(version.review.ageSafetyReviewed, true);
  // A revoked reviewer designation blocks later approvals.
  await db.doc(`organizations/${scope.orgId}/resourceReviewers/p313-reviewer`).update({ status: "revoked" });
  const next = await saveResource("p313-editor", { resourceId: saved.resourceId, expectedRevision: approved.revision });
  await domain(approve("p313-reviewer", saved.resourceId, next.revision), "PRACTICE_REVIEWER_REQUIRED");
  // Clients can never read resources or designations directly.
  for (const path of [`organizations/${scope.orgId}/practiceResources/${saved.resourceId}`, `organizations/${scope.orgId}/resourceReviewers/p313-reviewer2`]) {
    await assert.rejects(getDoc(doc(clientDb(apps["p313-reviewer2"]), path)), { code: "permission-denied" });
  }
});

test("stale editors and reviewers are rejected", async () => {
  const saved = await saveResource("p313-editor");
  await saveResource("p313-editor", { resourceId: saved.resourceId, expectedRevision: saved.revision, title: "First edit" });
  await domain(saveResource("p313-reviewer", { resourceId: saved.resourceId, expectedRevision: saved.revision, title: "Second edit" }), "STALE_REVISION");
  await domain(approve("p313-reviewer", saved.resourceId, saved.revision), "STALE_REVISION");
  // A retried request with the same ID replays instead of creating a second resource.
  const requestId = rid();
  const first = await saveResource("p313-editor", { requestId, title: "Retry" });
  const again = await saveResource("p313-editor", { requestId, title: "Retry" });
  assert.equal(again.resourceId, first.resourceId);
  // A deleting account cannot act, even on a replay.
  await db.doc("accountDeletionJobs/p313-editor").set({ status: "deleting" });
  await deny(saveResource("p313-editor", { requestId, title: "Retry" }));
});

test("coaches see published resources for their program filtered by age, across pages", async () => {
  const young = await publishNew({ title: "Young gates", ages: [6, 8] });
  const older = await publishNew({ title: "Older rondo", ages: [10, 12] });
  const both = await publishNew({ title: "Shared warmup", ages: [6, 12] });
  // A published resource in another program (sport) never reaches this team's coach.
  const hoops = await saveResource("p313-staff2", { programId: "p313-hoops", title: "Hoops drill" });
  assert.equal((await approve("p313-reviewer2", hoops.resourceId, hoops.revision)).state, "published");
  const seven = await coachList("p313-coach", { age: 7 });
  assert.deepEqual(seven.items.map((row) => row.resourceId).sort(), [young.resourceId, both.resourceId].sort());
  assert.equal(seven.items[0].instructions.startsWith("Synthetic original"), true);
  assert.equal(JSON.stringify(seven).includes("SYN-1"), false);
  assert.deepEqual((await coachList("p313-coach", { age: 16 })).items, []);
  // Page size one walks every match without dropping later pages.
  const seen = [];
  let cursor = null;
  do {
    const page = await coachList("p313-coach", { pageSize: 1, ...(cursor ? { cursor } : {}) });
    seen.push(...page.items.map((row) => row.resourceId));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(seen.sort(), [young.resourceId, older.resourceId, both.resourceId].sort());
  // Revoked coaches, players, guardians, other-program staff and other tenants cannot list.
  for (const uid of ["p313-revoked", "p313-player", "p313-guardian", "p313-foreign"]) await deny(coachList(uid));
  await deny(call("p313-staff2", "listPracticeResources", { orgId: scope.orgId, programId: scope.programId }));
  const editor = await call("p313-editor", "listPracticeResources", { orgId: scope.orgId, programId: scope.programId });
  assert.equal(editor.items.length, 3);
  await assert.rejects(coachList("p313-coach", { age: 99 }), { code: "functions/invalid-argument" });
  await db.doc(`organizations/${scope.orgId}`).update({ "features.practiceResources": false });
  await domain(coachList("p313-coach"), "PRACTICE_RESOURCES_DISABLED");
});

test("plans snapshot versions, keep private notes private and block withdrawn or expired resources", async () => {
  const drill = await publishNew({ title: "Passing gates" });
  const other = await publishNew({ title: "Cool down" });
  await domain(plan("p313-coach", 0, { action: "publish" }), "PRACTICE_PLAN_NOT_SAVED");
  const saved = await savePlan("p313-coach", 0, [{ resourceId: drill.resourceId, version: 1, plannedMinutes: 20 }], { privateNote: "Synthetic private coach note" });
  // Only an active coach on a practice event can save.
  for (const uid of ["p313-revoked", "p313-player", "p313-guardian", "p313-editor", "p313-foreign"]) await deny(savePlan(uid, saved.revision, []));
  await domain(call("p313-coach", "savePracticePlan", { requestId: rid(), orgId: scope.orgId, resourceId: "p313-other-event", expectedRevision: 0, payload: { teamId, action: "save", items: [] } }), "PRACTICE_PLAN_PRACTICE_ONLY");
  await domain(savePlan("p313-coach", 0, []), "STALE_REVISION");
  // Version 2 is published later; the saved plan keeps its version 1 snapshot.
  const edit = await saveResource("p313-editor", { resourceId: drill.resourceId, expectedRevision: drill.revision, title: "Passing gates v2" });
  await approve("p313-reviewer", drill.resourceId, edit.revision);
  let coach = await getPlan("p313-coach");
  assert.equal(coach.items[0].title, "Passing gates");
  assert.equal(coach.items[0].notice, "superseded");
  assert.equal(coach.privateNote, "Synthetic private coach note");
  // A stale version cannot be newly assigned in another position.
  const published = await plan("p313-coach", saved.revision, { action: "publish" });
  await domain(savePlan("p313-coach", published.revision, [
    { resourceId: drill.resourceId, version: 1, plannedMinutes: 20 }, { resourceId: other.resourceId, version: 2, plannedMinutes: 5 },
  ]), "PRACTICE_RESOURCE_UNAVAILABLE");
  const household = await getPlan("p313-guardian", "p313-a");
  assert.equal(household.state, "published");
  assert.equal(household.items[0].instructions.includes("Synthetic original"), true);
  const player = await getPlan("p313-player");
  for (const view of [household, player]) {
    const text = JSON.stringify(view);
    for (const secret of ["Synthetic private coach note", "privateNote", "SYN-1", "p313-coach", "p313-editor"]) assert.equal(text.includes(secret), false, secret);
  }
  await deny(getPlan("p313-outsider"));
  // Withdrawal blocks new and retained assignment, and households lose the instructions.
  const current = (await db.doc(`organizations/${scope.orgId}/practiceResources/${other.resourceId}`).get()).data();
  const retryId = rid();
  await withdraw("p313-editor", other.resourceId, current.revision);
  await domain(savePlan("p313-coach", published.revision, [{ resourceId: other.resourceId, version: 1, plannedMinutes: 5 }], {}, retryId), "PRACTICE_RESOURCE_UNAVAILABLE");
  await domain(savePlan("p313-coach", published.revision, [{ resourceId: other.resourceId, version: 1, plannedMinutes: 5 }], {}, retryId), "PRACTICE_RESOURCE_UNAVAILABLE");
  await domain(saveResource("p313-editor", { resourceId: other.resourceId, expectedRevision: current.revision + 1 }), "PRACTICE_RESOURCE_WITHDRAWN");
  assert.equal((await coachList("p313-coach")).items.some((row) => row.resourceId === other.resourceId), false);
  // Expiry of the recorded permission behaves like withdrawal for the plan already holding it.
  // Simulate time passing beyond the recorded end of the version this plan holds.
  const planRef = db.doc(`events/${eventId}/practicePlans/${teamId}`);
  const stored = (await planRef.get()).data();
  await planRef.update({ items: stored.items.map((row) => ({ ...row, rightsExpiresAt: Timestamp.fromMillis(Date.now() - 1000) })) });
  const viewRef = planRef.collection("views").doc("household");
  const view = (await viewRef.get()).data();
  await viewRef.update({ items: view.items.map((row) => ({ ...row, rightsExpiresAt: Timestamp.fromMillis(Date.now() - 1000) })) });
  coach = await getPlan("p313-coach");
  assert.equal(coach.items[0].notice, "expired");
  const expiredView = await getPlan("p313-guardian", "p313-a");
  assert.deepEqual(expiredView.items[0], { title: "Passing gates", plannedMinutes: 20, notice: "expired" });
  await domain(plan("p313-coach", published.revision, { action: "publish" }), "PRACTICE_RESOURCE_UNAVAILABLE");
  await domain(savePlan("p313-coach", published.revision, [{ resourceId: drill.resourceId, version: 1, plannedMinutes: 25 }]), "PRACTICE_RESOURCE_UNAVAILABLE");
  // Removing the activity saves; retracting removes the household copy.
  const cleared = await savePlan("p313-coach", published.revision, []);
  const retracted = await plan("p313-coach", cleared.revision, { action: "retract" });
  assert.equal(retracted.state, "private");
  assert.equal((await getPlan("p313-guardian", "p313-a")).state, "unpublished");
  const notes = (await db.doc(`events/${eventId}/practicePlans/${teamId}/notes/plan`).get()).exists;
  assert.equal(notes, false);
});

test("a kept older version stays bound to its own permission after a newer version is cleared", async () => {
  const expiresAt = new Date(Date.now() + 6000).toISOString();
  const saved = await saveResource("p313-editor", { rightsExtra: { expiresAt } });
  const approved = await approve("p313-reviewer", saved.resourceId, saved.revision);
  const planned = await savePlan("p313-coach", 0, [{ resourceId: saved.resourceId, version: 1, plannedMinutes: 10 }]);
  const published = await plan("p313-coach", planned.revision, { action: "publish" });
  // Version 2 replaces the text with permission that does not expire.
  const edit = await saveResource("p313-editor", { resourceId: saved.resourceId, expectedRevision: approved.revision, title: "Cleared rewrite" });
  await approve("p313-reviewer", saved.resourceId, edit.revision);
  assert.equal((await getPlan("p313-coach")).items[0].notice, "superseded");
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Date.parse(expiresAt) - Date.now()) + 500));
  assert.equal((await getPlan("p313-coach")).items[0].notice, "expired");
  const household = await getPlan("p313-guardian", "p313-a");
  assert.deepEqual(household.items[0], { title: "Passing gates", plannedMinutes: 10, notice: "expired" });
  await domain(plan("p313-coach", published.revision, { action: "publish" }), "PRACTICE_RESOURCE_UNAVAILABLE");
  await domain(savePlan("p313-coach", published.revision, [{ resourceId: saved.resourceId, version: 1, plannedMinutes: 12 }]), "PRACTICE_RESOURCE_UNAVAILABLE");
  // Switching to the cleared version is allowed.
  const switched = await savePlan("p313-coach", published.revision, [{ resourceId: saved.resourceId, version: 2, plannedMinutes: 12 }]);
  assert.equal((await getPlan("p313-coach")).items[0].title, "Cleared rewrite");
  assert.equal(switched.state, "published");
});
