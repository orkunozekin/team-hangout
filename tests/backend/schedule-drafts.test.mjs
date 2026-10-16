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
  setDoc,
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
const orgId = "p206-org",
  meta = { schemaVersion: 2, revision: 1, status: "active" };
const scope = {
  orgId,
  programId: "p206-program",
  seasonId: "p206-season",
  divisionId: "p206-division",
};
const call = async (uid, name, data) =>
  (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const invoke = (name, data) => call("p206-admin", name, data);
const req = (data) => ({ requestId: `p206-${++seq}`, ...data });
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
    "p206-admin",
    "p206-staff",
    "p206-coach",
    "p206-guardian",
    "p206-self",
    "p206-outsider",
    "p206-support",
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
      .set({ uid, appRole: uid === "p206-support" ? "superAdmin" : "user" });
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
    features: { organizationV2: true, adminWorkspace: true, scheduler: true },
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
    await db.doc(`teams/p206-${t}`).set({
      ...meta,
      ...scope,
      name: `Team ${t.toUpperCase()}`,
      sport: "soccer",
    });
  await db
    .doc(`organizations/${orgId}/members/p206-admin`)
    .set({ ...meta, orgId, roles: ["orgAdmin"], programIds: [] });
  await db.doc(`organizations/${orgId}/members/p206-staff`).set({
    ...meta,
    orgId,
    roles: ["programStaff"],
    programIds: [scope.programId],
  });
  await db.doc("teamMembers/p206-a_p206-coach").set({
    ...meta,
    orgId,
    teamId: "p206-a",
    userId: "p206-coach",
    roles: ["coach"],
  });
  await db
    .doc(`organizations/${orgId}/facilities/park`)
    .set({ ...meta, orgId, name: "Cedar Park", timeZone: "America/Chicago" });
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
test("complete generation, nonempty manual edit, independent validation and immutable history remain private", async () => {
  const d = input(),
    r = await generate(d);
  assert.equal(r.search.status, "feasible");
  assert.equal(r.assignments.length, 6);
  assert.equal(r.validationRevision, 1);
  assert.equal(r.validation.valid, true);
  // First/last game buffers extend outside the requested gameplay range and remain valid.
  assert.equal(r.validation.conflictCount, 0);
  assert.deepEqual(await generate(d), r);
  const edited = r.assignments.map((a, i) => ({
    ...a,
    slotId: i === 0 ? r.assignments[1].slotId : a.slotId,
  }));
  const saved = await invoke(
    "saveScheduleDraft",
    req({ ...identity(r), fields: r.fields, assignments: edited }),
  );
  assert.equal(saved.revision, 2);
  assert.equal(saved.validation, null);
  assert.equal(saved.validationRevision, null);
  assert.equal(saved.search, null);
  const v = await invoke("validateScheduleDraft", req(identity(saved)));
  assert.equal(v.revision, 3);
  assert.equal(v.validation.valid, false);
  assert.ok(v.validation.conflictCount > 0);
  const old = (
    await db
      .doc(`organizations/${orgId}/scheduleDrafts/${r.draftId}/revisions/1`)
      .get()
  ).data();
  assert.equal(old.validation.valid, true);
  assert.equal(old.revision, 1);
  await assert.rejects(
    invoke(
      "saveScheduleDraft",
      req({ ...identity(r), fields: r.fields, assignments: r.assignments }),
    ),
    (e) => e.details?.domainCode === "STALE_REVISION",
  );
  await assert.rejects(
    invoke("publishScheduleDraft", req(identity(v))),
    (e) => e.details?.domainCode === "PUBLICATION_DISABLED",
  );
  assert.equal(
    (await db.collection("events").where("orgId", "==", orgId).get()).size,
    0,
  );
  assert.equal(
    (await db.collection(`organizations/${orgId}/outbox`).get()).size,
    0,
  );
  assert.equal(
    (await db.collection(`organizations/${orgId}/scheduleOperations`).get())
      .size,
    0,
  );
  assert.equal(
    (
      await db
        .doc(`organizations/${orgId}/facilities/park/resources/north`)
        .get()
    ).data().reservationVersion,
    undefined,
  );
  assert.equal(JSON.stringify(r).includes("p206-coach"), false);
  for (const path of [
    `organizations/${orgId}/scheduleDrafts/${r.draftId}`,
    `organizations/${orgId}/scheduleDrafts/${r.draftId}/revisions/1`,
  ]) {
    await assert.rejects(getDoc(doc(clientDb(apps["p206-admin"]), path)), {
      code: "permission-denied",
    });
    await assert.rejects(setDoc(doc(clientDb(apps["p206-admin"]), path), {}), {
      code: "permission-denied",
    });
  }
});
test("impossible finite slots retain a truthful partial private draft; constraints and preferences are enforced", async () => {
  const f = fields();
  f.slots = f.slots.slice(0, 1);
  const r = await generate(input({ fields: f }));
  assert.equal(r.search.status, "impossible");
  assert.equal(r.search.completeness, "partial");
  assert.equal(r.assignments.length, 1);
  assert.equal(r.validation.unscheduledFixtureIds.length, 5);
  assert.equal(r.state, "privateDraft");
  f.teamConstraints = [
    {
      teamId: "p206-a",
      blackouts: [{ startsAt: at(2), endsAt: end(2) }],
      preferredSlotIds: ["s0"],
    },
  ];
  const c = await generate(input({ fields: f }));
  const assigned = new Set(c.assignments.map((a) => a.fixtureId));
  assert.equal(
    c.fixtures
      .filter((v) => assigned.has(v.id))
      .some((v) => [v.homeTeamId, v.awayTeamId].includes("p206-a")),
    false,
  );
  await assert.rejects(
    generate(
      input({
        fields: {
          ...f,
          teamConstraints: [
            { teamId: "foreign", blackouts: [], preferredSlotIds: [] },
          ],
        },
      }),
    ),
    { code: "functions/invalid-argument" },
  );
});
test("live grants, tenant references, rollout, archived hierarchy and replay cannot confer stale authority", async () => {
  const d = input(),
    r = await call("p206-staff", "generateScheduleDraft", d);
  for (const uid of [
    "p206-coach",
    "p206-guardian",
    "p206-self",
    "p206-outsider",
    "p206-support",
  ]) {
    await deny(call(uid, "generateScheduleDraft", input()));
    await deny(call(uid, "getScheduleDraft", { orgId, draftId: r.draftId }));
  }
  await deny(generate(input({ orgId: "foreign" })));
  await deny(generate(input({ divisionId: "foreign" })));
  await deny(
    generate(
      input({
        fields: {
          ...fields(),
          slots: [{ ...fields().slots[0], facilityId: "foreign" }],
        },
      }),
    ),
  );
  await db
    .doc(`organizations/${orgId}/members/p206-staff`)
    .update({ programIds: ["other"] });
  await deny(call("p206-staff", "generateScheduleDraft", d));
  await deny(
    call("p206-staff", "getScheduleDraft", { orgId, draftId: r.draftId }),
  );
  await db
    .doc(`organizations/${orgId}/members/p206-staff`)
    .update({ programIds: [scope.programId] });
  for (const flag of ["scheduler", "organizationV2", "adminWorkspace"]) {
    await db
      .doc(`organizations/${orgId}`)
      .update({ [`features.${flag}`]: false });
    await deny(generate(d));
    await deny(invoke("getScheduleDraft", { orgId, draftId: r.draftId }));
    await db
      .doc(`organizations/${orgId}`)
      .update({ [`features.${flag}`]: true });
  }
  await db
    .doc(`organizations/${orgId}/seasons/${scope.seasonId}`)
    .update({ status: "archived" });
  await assert.rejects(
    generate(d),
    (e) => e.details?.domainCode === "HIERARCHY_ARCHIVED",
  );
  await db
    .doc(`organizations/${orgId}/seasons/${scope.seasonId}`)
    .update({ status: "active" });
  await db.doc("users/p206-staff").update({ accountState: "deleting" });
  await deny(call("p206-staff", "generateScheduleDraft", d));
  await db.doc("users/p206-staff").update({ accountState: "active" });
});
test("revalidation uses changed availability, occupancy and live coach assignments with no foreign disclosure", async () => {
  const d = input(),
    r = await generate(d);
  await db.doc("events/p206-busy").set({
    ...meta,
    ...scope,
    publicationState: "published",
    status: "scheduled",
    teamIds: ["p206-a"],
    facilityId: "park",
    resourceId: "north",
    startsAt: Timestamp.fromDate(new Date(at(2))),
    endsAt: Timestamp.fromDate(new Date(end(2))),
    resourceOccupancy: { setupMinutes: 15, cleanupMinutes: 10 },
  });
  const v = await invoke("validateScheduleDraft", req(identity(r)));
  assert.equal(v.validation.valid, false);
  assert.notEqual(v.inputHash, r.inputHash);
  await db.doc("events/p206-busy").delete();
  await db.doc("teamMembers/p206-b_p206-coach").set({
    ...meta,
    orgId,
    teamId: "p206-b",
    userId: "p206-coach",
    roles: ["coach"],
  });
  const conflicting = fields();
  conflicting.slots = [0, 1].map((i) => ({
    ...conflicting.slots[0],
    id: `s${i}`,
  }));
  const c = await generate(input({ fields: conflicting }));
  assert.ok(c.validation.disclosures.some((v) => /Cross-organization/.test(v)));
  await db.doc("teamMembers/p206-b_p206-coach").delete();
  const ar = db.doc(
    `organizations/${orgId}/facilities/park/resources/north/availability/2`,
  );
  await ar.set({
    ...meta,
    revision: 2,
    effectiveFrom: "2035-01-02T12:30:00.000Z",
    windows: [
      {
        startsAt: "2035-01-02T12:30:00.000Z",
        endsAt: "2036-01-01T00:00:00.000Z",
      },
    ],
  });
  const changed = await invoke("validateScheduleDraft", req(identity(v)));
  assert.ok(
    changed.validation.conflicts.some(
      (c) => c.code === "RESOURCE_REVISION_BOUNDARY",
    ),
  );
  await ar.delete();
});
test("unknown references, request reuse, concurrent edits, explicit bounds and season timezone fail safely", async () => {
  const d = input(),
    r = await generate(d);
  await assert.rejects(
    generate({ ...d, fields: { ...d.fields, title: "Changed" } }),
    (e) => e.details?.domainCode === "REQUEST_ID_REUSED",
  );
  const edit = req({
    ...identity(r),
    fields: r.fields,
    assignments: r.assignments,
  });
  const both = await Promise.allSettled([
    invoke("saveScheduleDraft", edit),
    invoke("saveScheduleDraft", { ...edit, requestId: `racing-${++seq}` }),
  ]);
  assert.equal(both.filter((v) => v.status === "fulfilled").length, 1);
  const current = both.find((v) => v.status === "fulfilled").value;
  await assert.rejects(
    invoke(
      "saveScheduleDraft",
      req({
        ...identity(current),
        fields: r.fields,
        assignments: [{ fixtureId: "forged:fixture", slotId: "s0" }],
      }),
    ),
    { code: "functions/invalid-argument" },
  );
  await assert.rejects(
    generate(
      input({
        fields: {
          ...fields(),
          slots: Array.from({ length: 1001 }, (_, i) => ({
            ...fields().slots[0],
            id: `s${i}`,
          })),
        },
      }),
    ),
    { code: "functions/resource-exhausted" },
  );
  await assert.rejects(
    generate(
      input({ fields: { ...fields(), startsAt: "2035-01-01T00:00:00.000Z" } }),
    ),
    /season dates/,
  );
  await assert.rejects(
    generate(
      input({ fields: { ...fields(), startsAt: "2035-01-02T12:00:00-06:00" } }),
    ),
    /explicit UTC/,
  );
  await assert.rejects(
    generate(input({ fields: { ...fields(), coachIds: ["forged"] } })),
    { code: "functions/invalid-argument" },
  );
});
test("shared coaches are discovered from current canonical assignments across same-tenant divisions", async () => {
  const path = `organizations/${orgId}/facilities/park/resources/south`;
  const north = (
    await db.doc(`organizations/${orgId}/facilities/park/resources/north`).get()
  ).data();
  await db.doc(path).set({ ...north, label: "South field" });
  await db
    .doc(`${path}/availability/1`)
    .set(
      (
        await db
          .doc(
            `organizations/${orgId}/facilities/park/resources/north/availability/1`,
          )
          .get()
      ).data(),
    );
  await db
    .doc("teams/p206-other")
    .set({
      ...meta,
      ...scope,
      divisionId: "other-division",
      name: "Private other division",
      sport: "soccer",
    });
  await db
    .doc("teamMembers/p206-other_p206-coach")
    .set({
      ...meta,
      orgId,
      teamId: "p206-other",
      userId: "p206-coach",
      roles: ["coach"],
    });
  await db
    .doc("events/p206-coach-busy")
    .set({
      ...meta,
      ...scope,
      divisionId: "other-division",
      publicationState: "published",
      status: "scheduled",
      teamIds: ["p206-other"],
      startsAt: Timestamp.fromDate(new Date(at(2))),
      endsAt: Timestamp.fromDate(new Date(end(2))),
      notes: "PRIVATE-OTHER-DIVISION",
    });
  const f = fields();
  f.slots = [{ ...f.slots[0], resourceId: "south" }];
  const r = await generate(input({ fields: f }));
  assert.equal(r.validation.valid, true);
  const scheduled = new Set(r.assignments.map((a) => a.fixtureId));
  assert.equal(
    r.fixtures
      .filter((v) => scheduled.has(v.id))
      .some((v) => [v.homeTeamId, v.awayTeamId].includes("p206-a")),
    false,
  );
  assert.equal(JSON.stringify(r).includes("PRIVATE-OTHER-DIVISION"), false);
  assert.equal(JSON.stringify(r).includes("p206-other"), false);
  assert.equal(JSON.stringify(r).includes("p206-coach"), false);
  await db
    .doc("teamMembers/p206-other_p206-coach")
    .update({ status: "revoked" });
  const validated = await invoke(
    "saveScheduleDraft",
    req({
      ...identity(r),
      fields: r.fields,
      assignments: [
        {
          fixtureId: r.fixtures.find((v) =>
            [v.homeTeamId, v.awayTeamId].includes("p206-a"),
          ).id,
          slotId: "s0",
        },
      ],
    }),
  );
  const v = await invoke("validateScheduleDraft", req(identity(validated)));
  assert.equal(v.validation.valid, true);
  await db.doc("events/p206-coach-busy").delete();
  await db.doc("teams/p206-other").delete();
  await db.doc("teamMembers/p206-other_p206-coach").delete();
});
test("known feasible 32-team input can exhaust search and remains a private partial draft", async () => {
  const added = db.batch();
  for (let i = 0; i < 28; i++)
    added.set(db.doc(`teams/p206-large-${String(i).padStart(2, "0")}`), {
      ...meta,
      ...scope,
      name: `Large ${i}`,
      sport: "soccer",
    });
  await added.commit();
  const f = fields();
  f.minimumRestMinutes = 0;
  f.startsAt = at(2);
  f.slots = Array.from({ length: 1000 }, (_, i) => ({
    id: `s${i}`,
    facilityId: "park",
    resourceId: "north",
    startsAt: new Date(Date.parse(at(2)) + i * 2 * 3600000).toISOString(),
    endsAt: new Date(Date.parse(end(2)) + i * 2 * 3600000).toISOString(),
    late: false,
  }));
  f.endsAt = f.slots.at(-1).endsAt;
  const r = await generate(input({ fields: f }));
  assert.equal(r.search.status, "budgetExhausted");
  assert.equal(r.search.termination, "budgetExhausted");
  assert.ok(r.validation.unscheduledFixtureIds.length > 0);
  assert.equal(r.validation.valid, true);
  assert.equal(r.state, "privateDraft");
  const cleanup = db.batch();
  for (let i = 0; i < 28; i++)
    cleanup.delete(db.doc(`teams/p206-large-${String(i).padStart(2, "0")}`));
  await cleanup.commit();
});
test("event and team discovery overflows fail closed without truncation", async () => {
  const batch = db.batch();
  for (let i = 0; i < 29; i++)
    batch.set(db.doc(`teams/p206-over-${i}`), {
      ...meta,
      ...scope,
      name: "Overflow",
      sport: "soccer",
    });
  await batch.commit();
  await assert.rejects(
    generate(input()),
    (e) => e.code === "functions/resource-exhausted" && /teams/.test(e.message),
  );
  const cleanup = db.batch();
  for (let i = 0; i < 29; i++) cleanup.delete(db.doc(`teams/p206-over-${i}`));
  await cleanup.commit();
  for (let n = 0; n < 1001; n += 400) {
    const b = db.batch();
    for (let i = n; i < Math.min(1001, n + 400); i++)
      b.set(db.doc(`events/p206-budget-${i}`), {
        orgId,
        publicationState: "staged",
      });
    await b.commit();
  }
  await assert.rejects(
    generate(input()),
    (e) =>
      e.code === "functions/resource-exhausted" &&
      /event snapshot/.test(e.message),
  );
});
