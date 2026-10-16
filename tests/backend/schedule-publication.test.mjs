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
import {
  getFirestore as clientDb,
  connectFirestoreEmulator,
  doc,
  getDoc,
} from "firebase/firestore";
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
  seq = 0;
const apps = {};
const orgId = "p207-org",
  meta = { schemaVersion: 2, revision: 1, status: "active" };
const scope = {
  orgId,
  programId: "p207-program",
  seasonId: "p207-season",
  divisionId: "p207-division",
};
const call = async (uid, name, data) =>
  (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const invoke = (name, data) => call("p207-admin", name, data);
const req = (data) => ({ requestId: `p207-${++seq}`, ...data });
const at = (n) => `2035-01-${String(n).padStart(2, "0")}T12:00:00.000Z`;
const end = (n) => `2035-01-${String(n).padStart(2, "0")}T13:00:00.000Z`;
const fields = () => ({
  title: "Cedar division",
  startsAt: at(2),
  endsAt: end(7),
  durationMinutes: 60,
  minimumRestMinutes: 60,
  repetitions: 1,
  seed: 206,
  slots: Array.from({ length: 6 }, (_, i) => ({
    id: `s${i}`,
    facilityId: "park",
    resourceId: "north",
    startsAt: at(i + 2),
    endsAt: end(i + 2),
    late: i > 2,
  })),
  teamConstraints: [],
});
const input = (patch) =>
  req({
    orgId,
    draftId: `draft-${++seq}`,
    divisionId: scope.divisionId,
    expectedRevision: 0,
    fields: fields(),
    ...patch,
  });
const generate = (d) => invoke("generateScheduleDraft", d);
const identity = (r) => ({
  orgId,
  draftId: r.draftId,
  expectedRevision: r.revision,
});
const deny = (p) => assert.rejects(p, { code: "functions/permission-denied" });
before(async () => {
  admin = adminApp({ projectId });
  db = getFirestore(admin);
  for (const uid of [
    "p207-admin",
    "p207-staff",
    "p207-coach",
    "p207-guardian",
    "p207-self",
    "p207-outsider",
    "p207-support",
  ]) {
    apps[uid] = initializeApp({ projectId, apiKey: "demo-key" }, uid);
    connectAuthEmulator(getAuth(apps[uid]), "http://127.0.0.1:9099", {
      disableWarnings: true,
    });
    connectFunctionsEmulator(getFunctions(apps[uid]), "127.0.0.1", 5001);
    connectFirestoreEmulator(clientDb(apps[uid]), "127.0.0.1", 8080);
    await adminAuth(admin).createUser({
      uid,
      email: `${uid}@example.test`,
      password: "SyntheticPassword123!",
    });
    await db
      .doc(`users/${uid}`)
      .set({ uid, appRole: uid === "p207-support" ? "superAdmin" : "user" });
    await signInWithEmailAndPassword(
      getAuth(apps[uid]),
      `${uid}@example.test`,
      "SyntheticPassword123!",
    );
  }
  await db.doc(`organizations/${orgId}`).set({
    ...meta,
    name: "Cedar athletics",
    timeZone: "America/Chicago",
    features: {
      organizationV2: true,
      adminWorkspace: true,
      scheduler: true,
      households: true,
    },
  });
  for (const [kind, name] of [
    ["programs", scope.programId],
    ["seasons", scope.seasonId],
    ["divisions", scope.divisionId],
  ])
    await db.doc(`organizations/${orgId}/${kind}/${name}`).set({
      ...meta,
      ...scope,
      name,
      sportCode: "soccer",
      startsOn: "2035-01-01",
      endsOn: "2035-12-31",
    });
  for (const t of ["a", "b", "c", "d"])
    await db.doc(`teams/p207-${t}`).set({
      ...meta,
      ...scope,
      name: `Team ${t.toUpperCase()}`,
      sport: "soccer",
    });
  await db
    .doc(`organizations/${orgId}/members/p207-admin`)
    .set({ ...meta, orgId, roles: ["orgAdmin"], programIds: [] });
  await db.doc(`organizations/${orgId}/members/p207-staff`).set({
    ...meta,
    orgId,
    roles: ["programStaff"],
    programIds: [scope.programId],
  });
  await db.doc("teamMembers/p207-a_p207-coach").set({
    ...meta,
    orgId,
    teamId: "p207-a",
    userId: "p207-coach",
    roles: ["coach"],
  });
  await db
    .doc(`organizations/${orgId}/facilities/park`)
    .set({
      ...meta,
      orgId,
      name: "Cedar Park",
      address: "Synthetic park",
      timeZone: "America/Chicago",
    });
  await db.doc(`organizations/${orgId}/facilities/park/resources/north`).set({
    ...meta,
    orgId,
    facilityId: "park",
    label: "North field",
    sports: ["soccer"],
    setupMinutes: 15,
    cleanupMinutes: 10,
  });
  await db
    .doc(
      `organizations/${orgId}/facilities/park/resources/north/availability/1`,
    )
    .set({
      ...meta,
      orgId,
      facilityId: "park",
      resourceId: "north",
      effectiveFrom: "2035-01-01T00:00:00.000Z",
      windows: [
        {
          startsAt: "2035-01-01T00:00:00.000Z",
          endsAt: "2036-01-01T00:00:00.000Z",
        },
      ],
    });
});
after(async () => {
  await Promise.all(Object.values(apps).map(deleteApp));
  await deleteAdmin(admin);
});

async function advance(op, action = "advance", patch = {}) {
  return invoke(
    "advanceSchedulePublication",
    req({
      orgId,
      draftId: op.draftId,
      operationId: op.operationId,
      expectedRevision: op.revision,
      fencingToken: op.fencingToken,
      action,
      ...patch,
    }),
  );
}
async function begin(draft) {
  return invoke(
    "publishScheduleDraft",
    req({ ...identity(draft), confirmed: true }),
  );
}
const opPath = (op) =>
  `organizations/${orgId}/scheduleOperations/${op.operationId}`;
async function hidden(op) {
  const rows = await db
    .collection("events")
    .where("publicationOperationId", "==", op.operationId)
    .get();
  for (const row of rows.docs.slice(0, 1)) {
    await deny(invoke("getCanonicalEvent", { eventId: row.id }));
    await assert.rejects(
      getDoc(doc(clientDb(apps["p207-guardian"]), `events/${row.id}`)),
      { code: "permission-denied" },
    );
  }
  const team = await invoke("listCanonicalTeamEvents", {
    teamId: "p207-a",
    pageSize: 50,
  });
  assert.equal(
    team.items.some((e) => e.publicationOperationId === op.operationId),
    false,
  );
  const agenda = await call("p207-self", "listHouseholdAgenda", {
    from: at(1),
    to: "2035-04-01T00:00:00.000Z",
    pageSize: 50,
  });
  assert.equal(
    agenda.items.some((e) => rows.docs.some((r) => r.id === e.id)),
    false,
  );
  assert.equal(
    (await db.collection(`organizations/${orgId}/outbox`).get()).size,
    0,
  );
  assert.equal(
    (await db.collection("emailOutbox").where("orgId", "==", orgId).get()).size,
    0,
  );
}
test("bounded publication hides staging and promotion, verifies complete set, resumes exactly once and blocks stale/revoked callers", async () => {
  // 21-team round robin has 210 required events. A 201-assignment partial must stay private.
  for (let i = 4; i < 21; i++)
    await db
      .doc(`teams/p207-${i}`)
      .set({ ...meta, ...scope, name: `Team ${i}`, sport: "soccer" });
  const f = fields();
  f.startsAt = "2035-01-02T00:00:00.000Z";
  f.endsAt = "2035-02-01T00:00:00.000Z";
  f.minimumRestMinutes = 0;
  f.slots = Array.from({ length: 210 }, (_, i) => ({
    id: `s${i}`,
    facilityId: "park",
    resourceId: "north",
    late: false,
    startsAt: new Date(Date.parse(f.startsAt) + i * 3 * 3600000).toISOString(),
    endsAt: new Date(
      Date.parse(f.startsAt) + (i * 3 + 1) * 3600000,
    ).toISOString(),
  }));
  // Authoritative generator provides fixture handles; staff can assign a complete independent witness.
  let draft = await generate(input({ fields: f }));
  const assignments = draft.fixtures.map((fixture, i) => ({
    fixtureId: fixture.id,
    slotId: `s${i}`,
  }));
  draft = await invoke(
    "saveScheduleDraft",
    req({
      ...identity(draft),
      fields: f,
      assignments: assignments.slice(0, 201),
    }),
  );
  draft = await invoke("validateScheduleDraft", req(identity(draft)));
  await assert.rejects(
    begin(draft),
    (e) => e.details?.domainCode === "SCHEDULE_CONFLICT",
  );
  draft = await invoke(
    "saveScheduleDraft",
    req({ ...identity(draft), fields: f, assignments }),
  );
  draft = await invoke("validateScheduleDraft", req(identity(draft)));
  assert.equal(draft.validation.unscheduledFixtureIds.length, 0);
  await db
    .doc(`organizations/${orgId}/participants/child`)
    .set({
      ...meta,
      orgId,
      displayName: "Synthetic player",
      linkedUserId: "p207-self",
    });
  await db
    .doc(`teams/p207-a/roster/child`)
    .set({ ...meta, orgId, participantId: "child" });
  let op = await begin(draft);
  assert.equal(op.total, 210);
  const initial = op;
  const exact = req({
    orgId,
    draftId: op.draftId,
    operationId: op.operationId,
    expectedRevision: op.revision,
    fencingToken: op.fencingToken,
    action: "advance",
  });
  op = await invoke("advanceSchedulePublication", exact);
  assert.equal(op.stagingCursor, 100);
  await hidden(op); // process interruption during staging
  assert.deepEqual(await invoke("advanceSchedulePublication", exact), op);
  const loaded = await invoke("getSchedulePublication", {
    orgId,
    draftId: op.draftId,
  });
  assert.deepEqual(loaded.operation, op);
  await assert.rejects(
    invoke(
      "createEvent",
      req({
        teamId: "p207-a",
        event: {
          title: "Competing",
          type: "practice",
          teamIds: ["p207-a"],
          startsAt: at(9),
          endsAt: end(9),
          timeZone: "UTC",
          status: "scheduled",
          publicationState: "published",
        },
      }),
    ),
    (e) => e.details?.domainCode === "SCHEDULING_BUSY",
  );
  await assert.rejects(begin({ ...draft, draftId: "other" }), {
    code: "functions/permission-denied",
  });
  for (const [name, payload] of [
    [
      "saveFacility",
      {
        orgId,
        facilityId: "park",
        expectedRevision: 1,
        fields: {
          name: "Cedar Park",
          address: "Synthetic park",
          timeZone: "America/Chicago",
          latitude: null,
          longitude: null,
          parking: null,
          accessibility: null,
          status: "active",
        },
      },
    ],
    [
      "saveFacilityResource",
      {
        orgId,
        facilityId: "park",
        resourceId: "north",
        expectedRevision: 1,
        fields: {
          label: "North field",
          sports: ["soccer"],
          setupMinutes: 15,
          cleanupMinutes: 10,
          status: "active",
        },
      },
    ],
    [
      "archiveSeason",
      {
        orgId,
        seasonId: scope.seasonId,
        expectedRevision: 1,
        status: "archived",
      },
    ],
  ])
    await assert.rejects(
      invoke(name, req(payload)),
      (e) => e.details?.domainCode === "SCHEDULING_BUSY",
    );

  // Expired old fence cannot advance, and authorized resume fences the previous worker.
  await db.doc(opPath(op)).update({ expiresAt: Timestamp.fromMillis(0) });
  await assert.rejects(
    advance(op),
    (e) => e.details?.domainCode === "STALE_LEASE",
  );
  op = await advance(op, "resume");
  await assert.rejects(
    advance({ ...op, fencingToken: initial.fencingToken }),
    (e) => e.details?.domainCode === "STALE_LEASE",
  );
  await db
    .doc(`organizations/${orgId}/members/p207-admin`)
    .update({ status: "revoked" });
  await deny(advance(op));
  await deny(invoke("advanceSchedulePublication", exact));
  await db
    .doc(`organizations/${orgId}/members/p207-admin`)
    .update({ status: "active" });
  while (op.state === "staging") op = await advance(op);
  assert.equal(op.stagingCursor, 210);
  op = await advance(op);
  assert.equal(op.promotionCursor, 100);
  await hidden(op); // process interruption during promotion
  op = (await invoke("getSchedulePublication", { orgId, draftId: op.draftId }))
    .operation;
  while (op.state === "promoting") op = await advance(op);
  assert.equal(op.state, "verifying");
  await hidden(op); // process interruption immediately before commit
  // A cursor alone cannot prove an event is intact.
  const saved = (await db.doc(opPath(op)).get()).data();
  const target = db.doc(`events/${saved.expected[0].eventId}`);
  await target.update({ title: "Changed payload" });
  await assert.rejects(
    advance(op),
    (e) => e.details?.domainCode === "EVENT_CHANGED",
  );
  await hidden(op);
  await target.update({ title: f.title });
  op = await advance(op);
  assert.equal(op.state, "committed");
  assert.equal(
    (await db.collection(`organizations/${orgId}/outbox`).get()).size,
    1,
  );
  assert.equal(
    (
      await db
        .collection("events")
        .where("publicationOperationId", "==", op.operationId)
        .get()
    ).size,
    210,
  );
  const seen = new Set();
  for (const team of draft.teams) {
    let cursor = null;
    const ids = [];
    do {
      const page = await invoke("listCanonicalTeamEvents", {
        teamId: team.id,
        pageSize: 7,
        cursor,
      });
      ids.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(ids.length, 20);
    assert.equal(new Set(ids).size, 20);
    ids.forEach((id) => seen.add(id));
  }
  assert.equal(seen.size, 210);
  let cursor = null;
  const agendaIds = [];
  do {
    const page = await call("p207-self", "listHouseholdAgenda", {
      from: at(1),
      to: "2035-04-01T00:00:00.000Z",
      pageSize: 7,
      cursor,
    });
    agendaIds.push(...page.items.map((e) => e.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(agendaIds.length, 20);
  assert.equal(new Set(agendaIds).size, 20);
  await invoke("getCanonicalEvent", { eventId: saved.expected[0].eventId });
  assert.equal((await advance(op)).state, "committed");
});

test("trusted 201-event protocol fixture crosses 100/100/1 boundaries and stays hidden through all crash points", async () => {
  // Trusted synthetic setup exercises the same internal pass used by the callable.
  // It deliberately bypasses round-robin creation, never the product's complete-draft validator.
  const {
    publicationPass,
    payloadHash,
  } = require("./lib/scheduling/protocol.js");
  const tenant = "p207-protocol",
    operationId = "synthetic-201";
  const parents = {
    orgId: tenant,
    programId: "program",
    seasonId: "season",
    divisionId: "division",
  };
  await db
    .doc(`organizations/${tenant}`)
    .set({
      ...meta,
      name: "Synthetic protocol league",
      timeZone: "UTC",
      features: {
        organizationV2: true,
        households: true,
        calendarSubscriptions: true,
      },
    });
  await db
    .doc(`organizations/${tenant}/members/p207-admin`)
    .set({ ...meta, orgId: tenant, roles: ["orgAdmin"], programIds: [] });
  for (const [kind, key] of [
    ["programs", "program"],
    ["seasons", "season"],
    ["divisions", "division"],
  ])
    await db
      .doc(`organizations/${tenant}/${kind}/${key}`)
      .set({ ...meta, ...parents, name: key });
  const teamIds = ["p207-proto-a", "p207-proto-b"];
  for (const [i, teamId] of teamIds.entries()) {
    await db
      .doc(`teams/${teamId}`)
      .set({
        ...meta,
        ...parents,
        name: `Synthetic team ${i}`,
        sport: "soccer",
      });
    await db
      .doc(`organizations/${tenant}/participants/child${i}`)
      .set({
        ...meta,
        orgId: tenant,
        displayName: `Child ${i}`,
        linkedUserId: "p207-guardian",
      });
    await db
      .doc(`teams/${teamId}/roster/child${i}`)
      .set({ ...meta, orgId: tenant, participantId: `child${i}` });
  }
  const from = new Date(Date.now() + 86400000).toISOString(),
    to = new Date(Date.now() + 30 * 86400000).toISOString();
  const payloads = Array.from({ length: 201 }, (_, i) => ({
    ...meta,
    ...parents,
    publicationState: "staged",
    publicationOperationId: operationId,
    title: `Synthetic game ${i}`,
    type: "match",
    teamId: teamIds[0],
    teamIds,
    homeTeamId: teamIds[0],
    awayTeamId: teamIds[1],
    scheduleVersion: 1,
    startsAt: Timestamp.fromMillis(Date.parse(from) + i * 7200000),
    endsAt: Timestamp.fromMillis(Date.parse(from) + i * 7200000 + 3600000),
    timeZone: "UTC",
    status: "scheduled",
    location: null,
    deletedAt: null,
    createdBy: "p207-admin",
    updatedBy: "p207-admin",
  }));
  const ref = db.doc(
    `organizations/${tenant}/scheduleOperations/${operationId}`,
  );
  let op = {
    schemaVersion: 2,
    orgId: tenant,
    operationId,
    state: "staging",
    stagingCursor: 0,
    promotionCursor: 0,
    createdAt: Timestamp.now(),
    expected: payloads.map((e, i) => ({
      eventId: `p207-proto-${i}`,
      fixtureId: String(i),
      revision: 1,
      hash: payloadHash(e),
    })),
  };
  await ref.set(op);
  const subscription = await call(
    "p207-guardian",
    "createCalendarSubscription",
    req({ teamIds }),
  );
  const step = () =>
    db.runTransaction(async (tx) => {
      const before = (await tx.get(ref)).data();
      const next = await publicationPass(
        tx,
        before,
        async (fixtureId) => payloads[Number(fixtureId)],
      );
      tx.set(ref, next);
      if (next.state === "committed")
        tx.create(db.doc(`organizations/${tenant}/outbox/${operationId}`), {
          operationId,
          state: "pending",
        });
      return next;
    });
  async function assertHidden() {
    for (const teamId of teamIds)
      assert.deepEqual(
        (
          await call("p207-guardian", "listCanonicalTeamEvents", {
            teamId,
            pageSize: 50,
          })
        ).items,
        [],
      );
    assert.deepEqual(
      (
        await call("p207-guardian", "listHouseholdAgenda", {
          orgIds: [tenant],
          from,
          to,
        })
      ).items,
      [],
    );
    await deny(
      call("p207-guardian", "getCanonicalEvent", { eventId: "p207-proto-0" }),
    );
    const feed = await fetch(subscription.url);
    assert.equal(feed.status, 200);
    assert.equal((await feed.text()).includes("BEGIN:VEVENT"), false);
    assert.equal(
      (await db.collection(`organizations/${tenant}/outbox`).get()).size,
      0,
    );
    assert.equal(
      (await db.collection("emailOutbox").where("orgId", "==", tenant).get())
        .size,
      0,
    );
  }
  op = await step();
  assert.equal(op.stagingCursor, 100);
  await assertHidden();
  // Drop all local operation state and resume from the durable cursor after simulated process loss.
  op = (await ref.get()).data();
  op = await step();
  assert.equal(op.stagingCursor, 200);
  op = await step();
  assert.equal(op.stagingCursor, 201);
  assert.equal(op.state, "promoting");
  op = await step();
  assert.equal(op.promotionCursor, 100);
  await assertHidden();
  op = (await ref.get()).data();
  op = await step();
  assert.equal(op.promotionCursor, 200);
  op = await step();
  assert.equal(op.promotionCursor, 201);
  assert.equal(op.state, "verifying");
  await assertHidden();
  op = (await ref.get()).data();
  op = await step();
  assert.equal(op.state, "committed");
  for (const teamId of teamIds) {
    let cursor = null;
    const ids = [];
    do {
      const page = await call("p207-guardian", "listCanonicalTeamEvents", {
        teamId,
        cursor,
        pageSize: 50,
      });
      ids.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(ids.length, 201);
    assert.equal(new Set(ids).size, 201);
  }
  let cursor = null;
  const ids = [];
  do {
    const page = await call("p207-guardian", "listHouseholdAgenda", {
      orgIds: [tenant],
      from,
      to,
      pageSize: 50,
      cursor,
    });
    ids.push(...page.items.map((e) => e.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 201);
  assert.equal(new Set(ids).size, 201);
  const feed = await fetch(subscription.url);
  assert.equal(feed.status, 200);
  assert.equal((await feed.text()).match(/BEGIN:VEVENT/g)?.length, 201);
  for (const eventId of ["p207-proto-0", "p207-proto-100", "p207-proto-200"])
    await call("p207-guardian", "getCanonicalEvent", { eventId });
  assert.equal(
    (await db.collection(`organizations/${tenant}/outbox`).get()).size,
    1,
  );
});

test("live rollout and resource revisions block recovery; abort releases lease and preserves hidden history", async () => {
  // Use the existing 21-team tenant with a later conflict-free finite range.
  const f = fields();
  f.startsAt = "2035-03-01T00:00:00.000Z";
  f.endsAt = "2035-04-01T00:00:00.000Z";
  f.minimumRestMinutes = 0;
  f.slots = Array.from({ length: 210 }, (_, i) => ({
    id: `r${i}`,
    facilityId: "park",
    resourceId: "north",
    late: false,
    startsAt: new Date(Date.parse(f.startsAt) + i * 3 * 3600000).toISOString(),
    endsAt: new Date(
      Date.parse(f.startsAt) + (i * 3 + 1) * 3600000,
    ).toISOString(),
  }));
  let draft = await generate(input({ fields: f }));
  draft = await invoke(
    "saveScheduleDraft",
    req({
      ...identity(draft),
      fields: f,
      assignments: draft.fixtures.map((v, i) => ({
        fixtureId: v.id,
        slotId: `r${i}`,
      })),
    }),
  );
  draft = await invoke("validateScheduleDraft", req(identity(draft)));
  let op = await begin(draft);
  op = await advance(op);
  const competing = await generate(input({ fields: f })).catch((e) => e);
  assert.equal(competing.details?.domainCode, "SCHEDULING_BUSY");
  await db
    .doc(`organizations/${orgId}`)
    .update({ "features.scheduler": false });
  await deny(advance(op));
  await db.doc(`organizations/${orgId}`).update({ "features.scheduler": true });
  await db
    .doc(`organizations/${orgId}/facilities/park/resources/north`)
    .update({ revision: 2 });
  await assert.rejects(
    advance(op, "resume"),
    (e) => e.details?.domainCode === "INPUT_CHANGED",
  );
  const abortRequest = req({
    orgId,
    draftId: op.draftId,
    operationId: op.operationId,
    expectedRevision: op.revision,
    fencingToken: op.fencingToken,
    action: "abort",
  });
  op = await invoke("advanceSchedulePublication", abortRequest);
  assert.equal(op.state, "aborted");
  assert.equal(
    (await invoke("advanceSchedulePublication", abortRequest)).state,
    "aborted",
  );
  assert.equal(
    (await db.doc(`organizations/${orgId}/schedulingLock/current`).get()).data()
      .operationId,
    null,
  );
  assert.equal(
    (
      await db
        .collection("events")
        .where("publicationOperationId", "==", op.operationId)
        .get()
    ).size,
    100,
  );
  const event = (
    await db
      .collection("events")
      .where("publicationOperationId", "==", op.operationId)
      .get()
  ).docs[0];
  await deny(invoke("getCanonicalEvent", { eventId: event.id }));
  assert.equal(
    (
      await db
        .collection(`organizations/${orgId}/outbox`)
        .where("operationId", "==", op.operationId)
        .get()
    ).size,
    0,
  );
});
