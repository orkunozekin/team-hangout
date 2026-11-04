import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { initializeApp, deleteApp } from "firebase/app";
import {
  getAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
} from "firebase/auth";
import {
  getFunctions,
  connectFunctionsEmulator,
  httpsCallable,
} from "firebase/functions";
import { projectId, requireEmulators } from "./fixtures.mjs";
const require = createRequire(
  new URL("../../functions/package.json", import.meta.url),
);
const {
  initializeApp: adminApp,
  deleteApp: deleteAdmin,
} = require("firebase-admin/app");
const { getAuth: adminAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
requireEmulators();
let admin,
  db,
  sequence = 0;
const apps = {};
const window = {
  from: "2026-11-01T05:00:00.000Z",
  to: "2026-11-02T06:00:00.000Z",
};
const agenda = async (uid, data = {}) =>
  (
    await httpsCallable(
      getFunctions(apps[uid]),
      "listHouseholdAgenda",
    )({ ...window, ...data })
  ).data;
const common = { schemaVersion: 2, revision: 1, status: "active" };
const permissions = { viewSchedule: true, viewProfile: false };
before(async () => {
  admin = adminApp({ projectId });
  db = getFirestore(admin);
  for (const uid of [
    "ics-parent",
    "ics-staff",
    "ics-coach",
    "ics-outsider",
    "ics-self",
  ]) {
    const app = initializeApp({ projectId, apiKey: "demo-key" }, uid);
    apps[uid] = app;
    connectAuthEmulator(getAuth(app), "http://127.0.0.1:9099", {
      disableWarnings: true,
    });
    connectFunctionsEmulator(getFunctions(app), "127.0.0.1", 5001);
    await adminAuth(admin).createUser({
      uid,
      email: `${uid}@example.test`,
      password: "SyntheticPassword123!",
    });
    await db.doc(`users/${uid}`).set({ uid, appRole: "user" });
    await signInWithEmailAndPassword(
      getAuth(app),
      `${uid}@example.test`,
      "SyntheticPassword123!",
    );
  }
});
after(async () => {
  await Promise.all(Object.values(apps).map(deleteApp));
  await deleteAdmin(admin);
});
async function fixture() {
  const orgId = `ics-org-${++sequence}`,
    teamId = `ics-team-${sequence}`,
    seasonId = "fall",
    programId = "soccer",
    divisionId = "u12";
  const parent = { orgId, programId, seasonId, divisionId };
  const batch = db.batch();
  const set = (path, row) => batch.set(db.doc(path), row);
  set(`organizations/${orgId}`, {
    ...common,
    name: orgId,
    features: {
      households: true,
      organizationV2: true,
      calendarSubscriptions: true,
    },
  });
  set(`organizations/${orgId}/programs/${programId}`, {
    ...common,
    orgId,
    name: "Soccer",
  });
  set(`organizations/${orgId}/seasons/${seasonId}`, {
    ...common,
    orgId,
    programId,
    name: "Fall",
  });
  set(`organizations/${orgId}/divisions/${divisionId}`, {
    ...common,
    ...parent,
    name: "U12",
  });
  set(`teams/${teamId}`, { ...common, ...parent, name: "Synthetic Stars" });
  for (const [participantId, displayName] of [
    ["jamie", "Jamie"],
    ["casey", "Casey"],
  ]) {
    set(`organizations/${orgId}/participants/${participantId}`, {
      ...common,
      orgId,
      displayName,
      kind: "youth",
      linkedUserId: null,
    });
    set(
      `organizations/${orgId}/participants/${participantId}/guardians/ics-parent`,
      { ...common, orgId, participantId, userId: "ics-parent", permissions },
    );
    set(`users/ics-parent/participantLinks/${orgId}_${participantId}`, {
      orgId,
      participantId,
      status: "active",
    });
    set(`teams/${teamId}/roster/${participantId}`, {
      ...common,
      orgId,
      participantId,
    });
  }
  await batch.commit();
  return { orgId, teamId, parent };
}
async function event(f, id, fields = {}) {
  const row = {
    ...common,
    ...f.parent,
    teamId: f.teamId,
    teamIds: [f.teamId],
    title: id,
    type: "practice",
    startsAt: Timestamp.fromDate(new Date(Date.now() + 86400000)),
    endsAt: Timestamp.fromDate(new Date(Date.now() + 90000000)),
    timeZone: "America/Chicago",
    status: "scheduled",
    publicationState: "published",
    publicationOperationId: null,
    deletedAt: null,
    location: { name: "Demo field" },
    notes: "PRIVATE STAFF NOTE",
    privateProfile: { birthDate: "2016-01-01" },
    ...fields,
  };
  await db.doc(`events/${id}`).set(row);
  return row;
}

const call = async (name, data, uid = "ics-parent") =>
  (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const issue = (f, extra = {}) =>
  call("createCalendarSubscription", {
    requestId: `issue-${++sequence}`,
    teamIds: [f.teamId],
    ...extra,
  });
const feed = (url) => fetch(url, { redirect: "error" });
test("private feed is standard ICS, bounded and allowlisted, with no raw tokens in storage or replay", async () => {
  const f = await fixture();
  await event(f, "ics-standard", {
    title: "Practice, fun; \\ play\nBEGIN:VEVENT",
    location: { name: "Field, One", address: "Demo street" },
    revision: 3,
    updatedAt: Timestamp.now(),
  });
  await event(f, "ics-too-old", {
    startsAt: Timestamp.fromMillis(Date.now() - 31 * 86400000),
    endsAt: Timestamp.fromMillis(Date.now() - 30 * 86400000),
  });
  await event(f, "ics-too-far", {
    startsAt: Timestamp.fromMillis(Date.now() + 366 * 86400000),
    endsAt: Timestamp.fromMillis(Date.now() + 367 * 86400000),
  });
  await event(f, "ics-staged", { publicationState: "staged" });
  const payload = { requestId: `once-${++sequence}`, teamIds: [f.teamId] };
  const result = await call("createCalendarSubscription", payload);
  const response = await feed(result.url),
    text = await response.text();
  assert.equal(response.status, 200);
    assert.equal(response.headers.get("etag"), null);
  assert.match(response.headers.get("content-type"), /text\/calendar/);
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(text, /BEGIN:VCALENDAR\r\nVERSION:2.0/);
  assert.match(text, /UID:ics-standard@calendar.example.test/);
  assert.match(text, /SEQUENCE:3/);
  assert.equal((text.match(/^BEGIN:VEVENT\r\n/gm) || []).length, 1);
  for (const privateText of [
    "Jamie",
    "Casey",
    "PRIVATE",
    "birthDate",
    "ics-too-old",
    "ics-too-far",
    "ics-staged",
  ])
    assert.equal(text.includes(privateText), false);
  assert.match(text, /SUMMARY:Practice\\, fun\\; \\\\ play\\nBEGIN:VEVENT/);
  const token = new URL(result.url).searchParams.get("token");
  const rows = await db
    .collection("calendarSubscriptions")
    .where("ownerUid", "==", "ics-parent")
    .get();
  const receipts = await db
    .collection("commandRequests")
    .where("uid", "==", "ics-parent")
    .get();
  assert.equal(
    JSON.stringify(
      [...rows.docs, ...receipts.docs].map((d) => d.data()),
    ).includes(token),
    false,
  );
  assert.equal((await call("createCalendarSubscription", payload)).url, null);
  await assert.rejects(
    call("createCalendarSubscription", { ...payload, eventTypes: ["match"] }),
    { code: "functions/already-exists" },
  );
  await db.doc("events/ics-standard").update({
    revision: 4,
    startsAt: Timestamp.fromMillis(Date.now() + 2 * 86400000),
    endsAt: Timestamp.fromMillis(Date.now() + 2 * 86400000 + 3600000),
    updatedAt: Timestamp.now(),
  });
  const changed = await (await feed(result.url)).text();
  assert.match(changed, /UID:ics-standard@calendar.example.test/);
  assert.match(changed, /SEQUENCE:4/);
  await db.doc("events/ics-standard").update({ deletedAt: Timestamp.now() });
  assert.equal(
    (await (await feed(result.url)).text()).includes("ics-standard"),
    false,
  );
});
test("ownership, exact scope, participant naming opt-in, rotation, revoke and tombstones are enforced", async () => {
  const f = await fixture();
  await event(f, "ics-lifecycle");
  await assert.rejects(issue(f, { includeParticipantNames: true }), {
    code: "functions/invalid-argument",
  });
  await assert.rejects(issue(f, { teamIds: ["foreign"] }), {
    code: "functions/permission-denied",
  });
  await assert.rejects(
    issue(f, {
      participantRefs: [{ orgId: f.orgId, participantId: "foreign" }],
    }),
    { code: "functions/permission-denied" },
  );
  const issued = await issue(f, {
    participantRefs: [{ orgId: f.orgId, participantId: "jamie" }],
    includeParticipantNames: true,
  });
  const body = await (await feed(issued.url)).text();
  assert.match(body, /Jamie/);
  assert.equal(body.includes("Casey"), false);
  const rotate = {
    requestId: `rotate-${++sequence}`,
    subscriptionId: issued.subscription.id,
    expectedRevision: 1,
  };
  await assert.rejects(
    call("rotateCalendarSubscription", rotate, "ics-outsider"),
    { code: "functions/permission-denied" },
  );
  const rotated = await call("rotateCalendarSubscription", rotate);
  assert.equal((await feed(issued.url)).status, 404);
  assert.equal(await (await feed(issued.url)).text(), "Feed unavailable.");
  assert.equal((await feed(rotated.url)).status, 200);
  assert.equal((await call("rotateCalendarSubscription", rotate)).url, null);
  await db
    .doc(`organizations/${f.orgId}/participants/jamie/guardians/ics-parent`)
    .update({ status: "revoked" });
  assert.equal((await feed(rotated.url)).status, 404);
  // Other sibling still grants team access, but cannot replace the explicitly selected participant.
  const teamOnly = await issue(f);
  const remove = {
    requestId: `remove-${++sequence}`,
    subscriptionId: teamOnly.subscription.id,
    expectedRevision: 1,
  };
  await call("revokeCalendarSubscription", remove);
  await call("revokeCalendarSubscription", remove);
  const revoked = await feed(teamOnly.url);
  assert.equal(revoked.status, 404);
  assert.equal(await revoked.text(), "Feed unavailable.");
  assert.match(revoked.headers.get("cache-control"), /no-store/);
  const current = await issue(f);
  await db.doc("accountDeletionJobs/ics-parent").set({ status: "pending" });
  assert.equal((await feed(current.url)).status, 404);
  await assert.rejects(call("listCalendarSubscriptions", {}), {
    code: "functions/permission-denied",
  });
  await db.doc("accountDeletionJobs/ics-parent").delete();
});
test("current permissions, feature flags, enrollment and explicit selection constrain every fetch", async () => {
  const f = await fixture();
  await event(f, "ics-current");
  const issued = await issue(f, { eventTypes: ["match"] });
  assert.equal(
    (await (await feed(issued.url)).text()).includes("ics-current"),
    false,
  );
  await db.doc("events/ics-current").update({ type: "match" });
  assert.equal(
    (await (await feed(issued.url)).text()).includes("ics-current"),
    true,
  );
  await db
    .doc(`organizations/${f.orgId}`)
    .update({ "features.calendarSubscriptions": false });
  assert.equal((await feed(issued.url)).status, 404);
  // Revocation is available even when rollout is disabled.
  await call("revokeCalendarSubscription", {
    requestId: "disabled-remove",
    subscriptionId: issued.subscription.id,
    expectedRevision: 1,
  });
  await db
    .doc(`organizations/${f.orgId}`)
    .update({ "features.calendarSubscriptions": true });
  const restricted = await issue(f, {
    participantRefs: [{ orgId: f.orgId, participantId: "casey" }],
  });
  await db.doc(`teams/${f.teamId}/roster/casey`).update({ status: "removed" });
  assert.equal((await feed(restricted.url)).status, 404);
  const other = await fixture();
  await event(other, "ics-new-team");
  const fixed = await issue(f);
  assert.equal(
    (await (await feed(fixed.url)).text()).includes("ics-new-team"),
    false,
  );
  assert.deepEqual(
    (await call("listCalendarSubscriptions", {}, "ics-outsider")).items,
    [],
  );
  for (const url of [
    "http://127.0.0.1:5001/demo-team-hangout/us-central1/calendarFeed",
    "http://127.0.0.1:5001/demo-team-hangout/us-central1/calendarFeed?token=bad",
  ]) {
    const r = await feed(url);
    assert.equal(r.status, 404);
    assert.equal(await r.text(), "Feed unavailable.");
  }
});
const {
  encodeCalendar,
  foldLine,
  escapeText,
} = require("./lib/calendar/ics.js");
test("RFC encoder folds UTF-8 at 75 octets without splitting characters or allowing property injection", () => {
  const line = "SUMMARY:" + "⚽é".repeat(100);
  const folded = foldLine(line);
  for (const row of folded.split("\r\n"))
    assert.ok(Buffer.byteLength(row) <= 75);
  assert.equal(folded.replace(/\r\n /g, ""), line);
  assert.equal(escapeText("a\r\nb,c;d\\e"), "a\\nb\\,c\\;d\\\\e");
  const calendar = encodeCalendar(
    [
      {
        id: "stable",
        title: line,
        startsAt: "2026-11-01T06:30:00.000Z",
        endsAt: "2026-11-01T07:30:00.000Z",
        updatedAt: "2026-10-12T00:00:00.000Z",
        revision: 2,
        teams: [{ name: "Demo" }],
        location: null,
        participants: [],
      },
    ],
    "example.test",
  );
  assert.match(calendar, /DTSTART:20261101T063000Z/);
  assert.match(calendar, /DTEND:20261101T073000Z/);
  assert.ok(calendar.endsWith("END:VCALENDAR\r\n"));
});

test("feed size ceiling fails closed rather than returning a silently partial calendar", async () => {
  const f = await fixture();
  const issued = await issue(f);
  const prototype = await event(f, "ics-ceiling-base");
  const batch = db.batch();
  for (let i = 0; i < 499; i++)
    batch.set(db.doc(`events/ics-ceiling-${i}`), prototype);
  await batch.commit();
  const response = await feed(issued.url);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "Feed unavailable.");
  assert.match(response.headers.get("cache-control"), /no-store/);
});
