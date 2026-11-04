// Synthetic Phase 3 walkthrough seed for the local emulators ONLY. Every record is invented demo data.
// Run with `yarn seed:phase3` while the emulators are up; see docs/backend-testing.md.
import { createRequire } from "node:module";

const DEMO_PROJECT = "demo-team-hangout";
const loopback = (value) =>
  /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(value ?? "");
const projectOverrides = [
  process.env.GOOGLE_CLOUD_PROJECT,
  process.env.GCP_PROJECT,
  (() => {
    try {
      return JSON.parse(process.env.FIREBASE_CONFIG ?? "{}").projectId;
    } catch {
      return "unparseable";
    }
  })(),
].filter(Boolean);
if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  throw new Error(
    "Synthetic Phase 3 seed refuses to run with GOOGLE_APPLICATION_CREDENTIALS set.",
  );
}
process.env.FUNCTIONS_EMULATOR_HOST ??= "127.0.0.1:5001";
if (
  process.env.GCLOUD_PROJECT !== DEMO_PROJECT ||
  projectOverrides.some((id) => id !== DEMO_PROJECT) ||
  !loopback(process.env.FIRESTORE_EMULATOR_HOST) ||
  !loopback(process.env.FIREBASE_AUTH_EMULATOR_HOST) ||
  !loopback(process.env.FUNCTIONS_EMULATOR_HOST)
) {
  throw new Error(
    "Synthetic Phase 3 seed requires demo-team-hangout and loopback emulator hosts.",
  );
}
const fnRequire = createRequire(
  new URL("../functions/package.json", import.meta.url),
);
const appRequire = createRequire(new URL("../package.json", import.meta.url));
const { initializeApp: adminInit, deleteApp: adminDelete } =
  fnRequire("firebase-admin/app");
const { getFirestore, Timestamp } = fnRequire("firebase-admin/firestore");
const { getAuth: adminAuth } = fnRequire("firebase-admin/auth");
const { initializeApp, deleteApp } = appRequire("firebase/app");
const { getAuth, connectAuthEmulator, signInWithEmailAndPassword } =
  appRequire("firebase/auth");
const { getFunctions, connectFunctionsEmulator, httpsCallable } =
  appRequire("firebase/functions");
const [functionsHost, functionsPort] = (() => {
  const host = process.env.FUNCTIONS_EMULATOR_HOST;
  const split = host.lastIndexOf(":");
  return [
    host.slice(0, split).replace(/^\[|\]$/g, ""),
    Number(host.slice(split + 1)),
  ];
})();

const projectId = DEMO_PROJECT;
const password = "SyntheticPassword123!";
const orgId = "p3demo-org";
const scope = {
  orgId,
  programId: "p3demo-soccer",
  seasonId: "p3demo-fall",
  divisionId: "p3demo-u10",
};
const [FOX, HAWK, OWL, WOLF] = [
  "p3demo-foxes",
  "p3demo-hawks",
  "p3demo-owls",
  "p3demo-wolves",
];
const teams = {
  [FOX]: "Maple Foxes",
  [HAWK]: "River Hawks",
  [OWL]: "Cedar Owls",
  [WOLF]: "Granite Wolves",
};
const teamIds = Object.keys(teams);
const users = {
  "p3demo-coach": "Riley Coach",
  "p3demo-guardian": "Jordan Parent",
  "p3demo-manager": "Morgan Manager",
  "p3demo-editor": "Casey Editor",
};
const kids = [
  ["p3demo-kid1", "Jamie Parent"],
  ["p3demo-kid2", "Avery Stone"],
  ["p3demo-kid3", "Quinn Brooks"],
  ["p3demo-kid4", "Rowan Hale"],
  ["p3demo-kid5", "Sky Moreno"],
  ["p3demo-kid6", "Toby Lane"],
];
const RUN = Date.now().toString(36);
let seq = 0;
const rid = () => `p3demo-${RUN}-${++seq}`;
const now = Date.now();
const ts = (ms) => Timestamp.fromMillis(ms);
const day = (iso) => Timestamp.fromDate(new Date(iso));
const meta = () => ({
  schemaVersion: 2,
  revision: 1,
  status: "active",
  createdAt: Timestamp.now(),
  updatedAt: Timestamp.now(),
  createdBy: "p3demo-manager",
  updatedBy: "p3demo-manager",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const leagueRules = {
  rulesSchemaVersion: 1,
  points: { win: 3, draw: 1, loss: 0, forfeitWin: 3, forfeitLoss: 0 },
  allowDraws: true,
  forfeitScore: { winner: 3, loser: 0 },
  countedOutcomes: ["played", "forfeit"],
  tieBreakers: ["tablePoints", "scoreDifferential", "scoresFor", "wins"],
  scoreDifferentialCap: null,
  knockoutDeciders: [],
};
const knockoutRules = {
  ...leagueRules,
  allowDraws: false,
  points: { ...leagueRules.points, draw: 0 },
  knockoutDeciders: ["penalties"],
};
const played = (homeScore, awayScore) => ({
  outcome: "played",
  homeScore,
  awayScore,
  forfeitingTeamId: null,
  winnerTeamId: null,
  decider: null,
});

const admin = adminInit({ projectId });
const db = getFirestore(admin);
const apps = {};
const call = async (uid, name, data) => {
  try {
    return (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
  } catch (error) {
    throw new Error(
      `${name} as ${uid} failed: ${error.code} ${error.message} ${JSON.stringify(error.details ?? {})}`,
    );
  }
};
const env = (resourceId, expectedRevision, payload) => ({
  requestId: rid(),
  orgId,
  resourceId,
  expectedRevision,
  payload,
});
const comp = (id) => `organizations/${orgId}/competitions/${id}`;
const resultRev = async (cid, eventId) =>
  (await db.doc(`${comp(cid)}/results/${eventId}`).get()).data()?.revision ?? 0;
const finalize = async (cid, eventId, result) =>
  call(
    "p3demo-manager",
    "finalizeResult",
    env(cid, await resultRev(cid, eventId), { eventId, result }),
  );

const match = (
  id,
  title,
  home,
  away,
  startsAt,
  minutes,
  status,
  extra = {},
) => [
  id,
  {
    ...meta(),
    ...scope,
    title,
    type: "match",
    teamId: home,
    teamIds: [home, away],
    homeTeamId: home,
    awayTeamId: away,
    startsAt,
    endsAt: ts(startsAt.toMillis() + minutes * 60_000),
    timeZone: "America/Chicago",
    status,
    publicationState: "published",
    publicationOperationId: null,
    deletedAt: null,
    scheduleVersion: 1,
    location: { name: "Maple Park Field 2", address: null },
    ...extra,
  },
];
const events = Object.fromEntries([
  match(
    "p3demo-m1",
    "League: Foxes vs Hawks",
    FOX,
    HAWK,
    day("2026-10-03T15:00:00Z"),
    60,
    "completed",
  ),
  match(
    "p3demo-m2",
    "League: Owls vs Wolves",
    OWL,
    WOLF,
    day("2026-10-03T17:00:00Z"),
    60,
    "completed",
  ),
  match(
    "p3demo-m3",
    "League: Owls vs Foxes",
    OWL,
    FOX,
    day("2026-10-10T15:00:00Z"),
    60,
    "completed",
  ),
  match(
    "p3demo-m4",
    "League: Hawks vs Wolves",
    HAWK,
    WOLF,
    day("2026-10-10T17:00:00Z"),
    60,
    "completed",
  ),
  match(
    "p3demo-today",
    "League: Foxes vs Wolves (today)",
    FOX,
    WOLF,
    ts(now - 30 * 60_000),
    90,
    "scheduled",
  ),
  match(
    "p3demo-next",
    "League: Hawks vs Foxes (next week)",
    HAWK,
    FOX,
    ts(now + 7 * 86_400_000),
    60,
    "scheduled",
  ),
  [
    "p3demo-practice",
    {
      ...meta(),
      ...scope,
      title: "Foxes practice: passing",
      type: "practice",
      teamId: FOX,
      teamIds: [FOX],
      startsAt: ts(now + 86_400_000),
      endsAt: ts(now + 86_400_000 + 75 * 60_000),
      timeZone: "America/Chicago",
      status: "scheduled",
      publicationState: "published",
      publicationOperationId: null,
      deletedAt: null,
      scheduleVersion: 1,
      location: { name: "Maple Park Field 1", address: null },
    },
  ],
]);

async function reset() {
  for (const path of [
    `organizations/${orgId}/competitions`,
    `organizations/${orgId}/reportRuns`,
    `organizations/${orgId}/practiceResources`,
  ]) {
    await db.recursiveDelete(db.collection(path));
  }
  for (const snap of (
    await db.collection("events").where("orgId", "==", orgId).get()
  ).docs)
    await db.recursiveDelete(snap.ref);
}

async function seedBase() {
  for (const [uid, displayName] of Object.entries(users)) {
    const email = `${uid}@example.test`;
    await adminAuth(admin)
      .createUser({ uid, email, displayName, password })
      .catch((e) => {
        if (e.code !== "auth/uid-already-exists") throw e;
      });
    await db.doc(`users/${uid}`).set({
      uid,
      email,
      displayName,
      appRole: "user",
      activeTeamId: ["p3demo-coach", "p3demo-guardian"].includes(uid)
        ? FOX
        : null,
    });
  }
  const b = db.batch();
  b.set(db.doc(`organizations/${orgId}`), {
    ...meta(),
    name: "Maple Valley Youth Soccer (synthetic)",
    kind: "club",
    timeZone: "America/Chicago",
    features: {
      organizationV2: true,
      households: true,
      attendance: true,
      reports: true,
      practiceResources: true,
      rides: true,
    },
  });
  b.set(db.doc(`organizations/${orgId}/programs/${scope.programId}`), {
    ...meta(),
    orgId,
    name: "Youth Soccer",
    sportCode: "soccer",
  });
  b.set(db.doc(`organizations/${orgId}/seasons/${scope.seasonId}`), {
    ...meta(),
    orgId,
    programId: scope.programId,
    name: "Fall 2026",
    startsOn: "2026-09-01",
    endsOn: "2026-12-15",
  });
  b.set(db.doc(`organizations/${orgId}/divisions/${scope.divisionId}`), {
    ...meta(),
    orgId,
    programId: scope.programId,
    seasonId: scope.seasonId,
    name: "U10",
    ageBandLabel: null,
  });
  b.set(db.doc(`organizations/${orgId}/members/p3demo-manager`), {
    ...meta(),
    orgId,
    roles: ["orgAdmin"],
    programIds: [],
  });
  b.set(db.doc(`organizations/${orgId}/members/p3demo-editor`), {
    ...meta(),
    orgId,
    roles: ["programStaff"],
    programIds: [scope.programId],
  });
  b.set(db.doc(`organizations/${orgId}/resourceReviewers/p3demo-manager`), {
    ...meta(),
    orgId,
    userId: "p3demo-manager",
    programIds: [scope.programId],
    qualification: "Synthetic safeguarding and coaching review",
  });
  for (const uid of ["p3demo-manager", "p3demo-editor"])
    b.set(db.doc(`users/${uid}/organizationLinks/${orgId}`), {
      orgId,
      status: "active",
    });
  for (const [id, name] of Object.entries(teams))
    b.set(db.doc(`teams/${id}`), {
      ...meta(),
      ...scope,
      name,
      sport: "soccer",
      inviteCode: null,
    });
  b.set(db.doc(`teamMembers/${FOX}_p3demo-coach`), {
    ...meta(),
    orgId,
    teamId: FOX,
    userId: "p3demo-coach",
    roles: ["coach"],
    displayName: "Riley Coach",
  });
  // Gives the guardian an active team context in the app; household authority comes from the guardian link below.
  b.set(db.doc(`teamMembers/${FOX}_p3demo-guardian`), {
    ...meta(),
    orgId,
    teamId: FOX,
    userId: "p3demo-guardian",
    roles: ["parent"],
    displayName: "Jordan Parent",
  });
  for (const [pid, displayName] of kids) {
    b.set(db.doc(`organizations/${orgId}/participants/${pid}`), {
      ...meta(),
      orgId,
      displayName,
      kind: "youth",
      linkedUserId: null,
      accessRevision: 1,
    });
    b.set(db.doc(`teams/${FOX}/roster/${pid}`), {
      ...meta(),
      orgId,
      teamId: FOX,
      participantId: pid,
      jerseyNumber: String(kids.findIndex((k) => k[0] === pid) + 3),
    });
  }
  b.set(
    db.doc(
      `organizations/${orgId}/participants/p3demo-kid1/guardians/p3demo-guardian`,
    ),
    {
      ...meta(),
      orgId,
      participantId: "p3demo-kid1",
      userId: "p3demo-guardian",
      permissions: {
        viewSchedule: true,
        respond: true,
        viewProfile: true,
        editProfile: false,
      },
    },
  );
  b.set(db.doc(`users/p3demo-guardian/participantLinks/${orgId}_p3demo-kid1`), {
    orgId,
    participantId: "p3demo-kid1",
    status: "active",
    relationship: "guardian",
  });
  for (const [id, data] of Object.entries(events))
    b.set(db.doc(`events/${id}`), data);
  // Attendance on two Foxes matches feeds the team attendance report.
  const marks = {
    "p3demo-m1": ["present", "present", "late", "absent", "present", "present"],
    "p3demo-m3": ["present", "absent", "present", "present", "late", "present"],
  };
  for (const [eventId, statuses] of Object.entries(marks)) {
    b.update(db.doc(`events/${eventId}`), {
      rosterSnapshot: {
        schemaVersion: 2,
        capturedRevision: 1,
        scheduleVersion: 1,
        participantCount: kids.length,
        eligibleCount: kids.length,
      },
    });
    kids.forEach(([pid, displayName], i) => {
      b.set(db.doc(`events/${eventId}/rosterSnapshots/${pid}`), {
        schemaVersion: 2,
        orgId,
        eventId,
        participantId: pid,
        displayName,
        teamIds: [FOX],
        capturedRevision: 1,
        enrollments: [{ teamId: FOX, eligible: true, status: "active" }],
        eligible: true,
      });
      b.set(db.doc(`events/${eventId}/attendance/${pid}`), {
        schemaVersion: 2,
        orgId,
        eventId,
        participantId: pid,
        status: statuses[i],
        scheduleVersion: 1,
        revision: 1,
        teamId: FOX,
      });
    });
  }
  await b.commit();
  for (const uid of Object.keys(users)) {
    const app = initializeApp(
      { projectId, apiKey: "demo-key" },
      `${uid}-${RUN}`,
    );
    apps[uid] = app;
    connectAuthEmulator(
      getAuth(app),
      `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`,
      { disableWarnings: true },
    );
    connectFunctionsEmulator(getFunctions(app), functionsHost, functionsPort);
    await signInWithEmailAndPassword(
      getAuth(app),
      `${uid}@example.test`,
      password,
    );
  }
}

async function waitFor(label, check, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(750);
  }
  throw new Error(
    `Timed out waiting for ${label} (are background triggers enabled in the functions emulator?)`,
  );
}

async function seedCompetition() {
  await call(
    "p3demo-manager",
    "saveCompetitionRules",
    env("p3demo-league", 0, {
      programId: scope.programId,
      seasonId: scope.seasonId,
      divisionId: scope.divisionId,
      name: "Fall League",
      format: "league",
      teamIds,
      rules: leagueRules,
      confirm: true,
    }),
  );
  await finalize("p3demo-league", "p3demo-m1", played(3, 1));
  await finalize("p3demo-league", "p3demo-m2", played(2, 2));
  await finalize("p3demo-league", "p3demo-m3", played(0, 2));
  await finalize("p3demo-league", "p3demo-m4", played(1, 0));
  // Today's match: the coach proposes a score; a manager has not finalized it yet.
  await call(
    "p3demo-coach",
    "proposeResult",
    env("p3demo-league", 0, {
      eventId: "p3demo-today",
      teamId: FOX,
      result: played(2, 1),
    }),
  );
  await waitFor("league standings", async () => {
    const s = await call("p3demo-manager", "getStandings", {
      orgId,
      competitionId: "p3demo-league",
    }).catch(() => null);
    return s?.status === "current" && s.rows?.length === 4 && s;
  });

  await call(
    "p3demo-manager",
    "saveCompetitionRules",
    env("p3demo-cup", 0, {
      programId: scope.programId,
      seasonId: scope.seasonId,
      divisionId: scope.divisionId,
      name: "Autumn Cup",
      format: "knockout",
      teamIds,
      rules: knockoutRules,
      confirm: true,
    }),
  );
  const seedOverride = {
    teamIds: [FOX, WOLF, HAWK, OWL],
    reason: "Synthetic draw for the walkthrough",
  };
  const preview = await call("p3demo-manager", "previewBracket", {
    orgId,
    competitionId: "p3demo-cup",
    sourceCompetitionId: null,
    seedOverride,
  });
  if (preview.blocked)
    throw new Error(
      `Bracket preview blocked: ${JSON.stringify(preview.blocked)}`,
    );
  await call(
    "p3demo-manager",
    "publishBracket",
    env("p3demo-cup", preview.bracketRevision, {
      sourceCompetitionId: null,
      generationId: null,
      sourceRevision: null,
      seedOverride,
      previewHash: preview.previewHash,
    }),
  );
  const node = async (nodeId) =>
    (await db.doc(`${comp("p3demo-cup")}/bracketNodes/${nodeId}`).get()).data();
  const bracketRev = async () =>
    (await db.doc(comp("p3demo-cup")).get()).data().bracketRevision;
  const link = async (nodeId, eventId) =>
    call(
      "p3demo-manager",
      "linkBracketEvent",
      env("p3demo-cup", await bracketRev(), { nodeId, eventId }),
    );
  for (const [nodeId, eventId, iso, score] of [
    ["r1-01", "p3demo-s1", "2026-10-24T15:00:00Z", played(2, 0)],
    ["r1-02", "p3demo-s2", "2026-10-24T17:00:00Z", played(1, 3)],
  ]) {
    const [home, away] = (await node(nodeId)).teamIds;
    const [id, data] = match(
      eventId,
      `Cup semifinal: ${teams[home]} vs ${teams[away]}`,
      home,
      away,
      day(iso),
      60,
      "completed",
    );
    await db.doc(`events/${id}`).set(data);
    await link(nodeId, eventId);
    await finalize("p3demo-cup", eventId, score);
  }
  const final = await waitFor("cup final teams", async () => {
    const n = await node("r2-01");
    return n?.teamIds?.every(Boolean) && n;
  });
  const [fid, fdata] = match(
    "p3demo-cup-final",
    `Cup final: ${teams[final.teamIds[0]]} vs ${teams[final.teamIds[1]]}`,
    final.teamIds[0],
    final.teamIds[1],
    ts(now + 10 * 86_400_000),
    60,
    "scheduled",
  );
  await db.doc(`events/${fid}`).set(fdata);
  await link("r2-01", fid);
}

async function seedTodayMatch() {
  const eventId = "p3demo-today";
  await call(
    "p3demo-coach",
    "saveLineup",
    env(eventId, 0, {
      teamId: FOX,
      sportPresetId: "soccer",
      note: "Synthetic private coaching note: rotate keeper at half.",
      units: [
        {
          unitId: "starting",
          slots: [
            { slotId: "gk", participantId: "p3demo-kid1", x: 0.5, y: 0.9 },
            { slotId: "st", participantId: "p3demo-kid2", x: 0.5, y: 0.1 },
          ],
        },
      ],
      bench: ["p3demo-kid3", "p3demo-kid4", "p3demo-kid5", "p3demo-kid6"],
    }),
  );
  await call(
    "p3demo-coach",
    "publishLineup",
    env(eventId, 1, { teamId: FOX, action: "publish" }),
  );
  const act = (rev, payload) =>
    call(
      "p3demo-coach",
      "recordPlayAction",
      env(eventId, rev, { teamId: FOX, ...payload }),
    );
  await act(0, { kind: "start", periodCount: 2 });
  await sleep(1500);
  await act(1, {
    kind: "substitute",
    unitId: "starting",
    outParticipantId: "p3demo-kid2",
    inParticipantId: "p3demo-kid3",
  });
  await sleep(1500);
  await act(2, {
    kind: "correct",
    targetSequence: 2,
    atElapsedMs: 500,
    outParticipantId: "p3demo-kid2",
    inParticipantId: "p3demo-kid4",
    reason: "Scorer sheet shows Rowan came on, not Quinn",
  });
  // Session stays running (not finalized) for the manual clock walkthrough.

  // Volunteer slots: one claimed by the guardian, one open.
  const slot = (payload) =>
    call(
      "p3demo-coach",
      "saveVolunteerSlot",
      env(eventId, 0, { teamId: FOX, ...payload }),
    );
  // The match already kicked off, so claims stay open until shortly before it ends.
  const claimDeadline = new Date(now + 45 * 60_000).toISOString();
  const snacks = await slot({
    kind: "snacks",
    title: "Halftime oranges",
    capacity: 2,
    claimDeadline,
  });
  await slot({
    kind: "snacks",
    title: "Post-game water",
    capacity: 1,
    claimDeadline,
  });
  await call(
    "p3demo-guardian",
    "claimVolunteerSlot",
    env(eventId, null, {
      teamId: FOX,
      slotId: snacks.slotId,
      displayAlias: "Jordan P.",
      showAlias: true,
    }),
  );
  for (const [title, capacity] of [
    ["Bring cones", 1],
    ["Field setup", 2],
  ]) {
    await call(
      "p3demo-coach",
      "saveVolunteerSlot",
      env("p3demo-practice", 0, {
        teamId: FOX,
        kind: "snacks",
        title,
        capacity,
      }),
    );
  }
}

async function seedPractice() {
  const content = (title, ageMin, ageMax, minutes) => ({
    title,
    objectives: ["Synthetic passing objective"],
    ageMin,
    ageMax,
    durationMinutes: minutes,
    equipment: ["Cones", "Pinnies"],
    instructions: `Synthetic original instructions for ${title}. Pairs pass through cone gates, then rotate.`,
    safetyNotes: "Synthetic safety reminder: keep spacing and hydrate.",
  });
  const rights = {
    origin: "original",
    owner: "Maple Valley Youth Soccer (synthetic)",
    allowedUses: "Internal coaching use",
    attribution: null,
    evidence: "Synthetic authorship record SYN-1",
    licenseUrl: null,
    expiresAt: null,
    derivativesAllowed: true,
  };
  const items = [];
  for (const [title, minutes] of [
    ["Passing gates", 20],
    ["Rondo 4v1", 15],
    ["Cool down stretch", 10],
  ]) {
    const saved = await call("p3demo-editor", "savePracticeResource", {
      requestId: rid(),
      orgId,
      resourceId: null,
      expectedRevision: 0,
      payload: {
        programId: scope.programId,
        content: content(title, 7, 11, minutes),
        rights,
      },
    });
    await call("p3demo-manager", "publishPracticeResource", {
      requestId: rid(),
      orgId,
      resourceId: saved.resourceId,
      expectedRevision: saved.revision,
      payload: {
        action: "approve",
        rightsVerified: true,
        ageSafetyReviewed: true,
      },
    });
    items.push({
      resourceId: saved.resourceId,
      version: 1,
      plannedMinutes: minutes,
    });
  }
  const plan = (rev, payload) =>
    call("p3demo-coach", "savePracticePlan", {
      requestId: rid(),
      orgId,
      resourceId: "p3demo-practice",
      expectedRevision: rev,
      payload: { teamId: FOX, ...payload },
    });
  const saved = await plan(0, {
    action: "save",
    items: items.slice(0, 2),
    householdNote: "Bring water and shin guards.",
    privateNote: "Synthetic private note: pair Jamie with Toby.",
  });
  await plan(saved.revision, { action: "publish" });
}

async function seedReport() {
  const { runId } = await call("p3demo-coach", "requestReport", {
    requestId: rid(),
    orgId,
    filters: {
      kind: "attendance",
      ...{ programId: scope.programId, seasonId: scope.seasonId },
      teamId: FOX,
      fromDate: "2026-09-01",
      toDate: "2026-10-28",
    },
  });
  const run = await waitFor("attendance report", async () => {
    const r = await call("p3demo-coach", "getReportRun", { orgId, runId });
    return r.run.state === "complete" && r.run;
  });
  const file = await call("p3demo-coach", "exportReport", { orgId, runId });
  return { runId, rate: run.summary?.presenceRate, csvRows: file.rowCount };
}

async function verify() {
  const q = { eventId: "p3demo-today", teamId: FOX };
  const out = {};
  out.guardianLineup = (
    await call("p3demo-guardian", "getLineupView", {
      ...q,
      participantId: "p3demo-kid1",
    })
  ).state;
  out.coachPlay =
    (await call("p3demo-coach", "getPlaySession", q)).state ?? "ok";
  out.results =
    (await call("p3demo-coach", "getEventResults", q)).competitions?.map(
      (c) => `${c.competitionId}:${c.result?.status ?? c.status ?? "?"}`,
    ) ?? "ok";
  out.standings =
    (await call("p3demo-guardian", "getEventStandings", q)).status ?? "ok";
  out.bracket = (await call("p3demo-guardian", "getEventBracket", q)).bracket
    ? "present"
    : "missing";
  out.volunteers = (
    await call("p3demo-guardian", "getEventVolunteers", q)
  ).slots?.length;
  out.rides = (await call("p3demo-guardian", "getEventRides", q)).enabled;
  out.practicePlanGuardian =
    (
      await call("p3demo-guardian", "getEventPracticePlan", {
        eventId: "p3demo-practice",
        teamId: FOX,
        participantId: "p3demo-kid1",
      })
    ).state ?? "ok";
  return out;
}

try {
  await reset();
  await seedBase();
  await seedCompetition();
  await seedTodayMatch();
  await seedPractice();
  const report = await seedReport();
  console.log("report", JSON.stringify(report));
  console.log("verify", JSON.stringify(await verify()));
  console.log(
    `Seeded Phase 3 demo. Logins (password ${password}): p3demo-coach@example.test, p3demo-guardian@example.test, p3demo-manager@example.test, p3demo-editor@example.test`,
  );
} finally {
  await Promise.all(Object.values(apps).map((app) => deleteApp(app)));
  await adminDelete(admin);
}
