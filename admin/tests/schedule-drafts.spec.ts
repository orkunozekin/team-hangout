import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../functions/package.json", import.meta.url),
);
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
if (
  process.env.ADMIN_EMULATOR_TESTS !== "1" ||
  process.env.GCLOUD_PROJECT !== "demo-team-hangout" ||
  process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8080"
)
  throw new Error("Use the isolated admin emulator harness.");
test.describe.configure({ mode: "serial" });
let app: ReturnType<typeof initializeApp>, db: ReturnType<typeof getFirestore>;
const orgId = "browser-drafts",
  uid = "draft-owner",
  password = "SyntheticPassword123!";
const meta = { schemaVersion: 2, revision: 1, status: "active" };
test.beforeAll(async () => {
  app = initializeApp({ projectId: "demo-team-hangout" });
  db = getFirestore(app);
  await getAuth(app).createUser({
    uid,
    email: `${uid}@example.test`,
    password,
  });
  await db.doc(`users/${uid}`).set({ uid, appRole: "user" });
  await db.doc(`organizations/${orgId}`).set({
    ...meta,
    name: "Cedar Park Athletics",
    timeZone: "America/Chicago",
    features: { organizationV2: true, adminWorkspace: true, scheduler: true },
  });
  await db
    .doc(`organizations/${orgId}/members/${uid}`)
    .set({ ...meta, orgId, roles: ["orgAdmin"], programIds: [] });
  const scope = {
    orgId,
    programId: "draft-program",
    seasonId: "draft-season",
    divisionId: "draft-division",
  };
  for (const [kind, id] of [
    ["programs", scope.programId],
    ["seasons", scope.seasonId],
    ["divisions", scope.divisionId],
  ])
    await db.doc(`organizations/${orgId}/${kind}/${id}`).set({
      ...meta,
      ...scope,
      name: id,
      sportCode: "soccer",
      startsOn: "2035-01-01",
      endsOn: "2035-12-31",
    });
  for (const [id, name] of [
    ["a", "Falcons"],
    ["b", "Herons"],
    ["c", "Owls"],
    ["d", "Kites"],
  ])
    await db
      .doc(`teams/draft-${id}`)
      .set({ ...meta, ...scope, name, sport: "soccer" });
  await db
    .doc(`organizations/${orgId}/facilities/cedar`)
    .set({ ...meta, orgId, name: "Cedar Park", timeZone: "America/Chicago" });
  await db.doc(`organizations/${orgId}/facilities/cedar/resources/north`).set({
    ...meta,
    orgId,
    facilityId: "cedar",
    label: "North field",
    sports: ["soccer"],
    setupMinutes: 15,
    cleanupMinutes: 10,
  });
  await db
    .doc(
      `organizations/${orgId}/facilities/cedar/resources/north/availability/1`,
    )
    .set({
      ...meta,
      effectiveFrom: "2035-01-01T00:00:00.000Z",
      windows: [
        {
          startsAt: "2035-01-01T00:00:00.000Z",
          endsAt: "2036-01-01T00:00:00.000Z",
        },
      ],
    });
});
test.afterAll(async () => {
  await deleteApp(app);
});

async function open(page: Page) {
  await page.goto(`/organizations/${orgId}/drafts`);
  await page.getByLabel("Email address").fill(`${uid}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByLabel("Draft title")).toBeVisible();
}
async function fill(page: Page, partial = false) {
  await page.getByLabel("Division ID", { exact: true }).fill("draft-division");
  await page
    .getByLabel("Draft title")
    .fill(
      partial
        ? "Winter league · limited field availability"
        : "Winter league · round robin",
    );
  await page.getByLabel("Range start (UTC)").fill("2035-01-02T12:00:00.000Z");
  await page
    .getByLabel("Range end (UTC, exclusive)")
    .fill("2035-01-07T13:00:00.000Z");
  await page
    .getByText("Candidate slots and team constraints", { exact: true })
    .click();
  for (let i = 0; i < (partial ? 1 : 6); i++) {
    await page
      .getByRole("button", { name: "Add candidate slot", exact: true })
      .click();
    await page
      .getByLabel(`Facility ID for slot ${i + 1}`, { exact: true })
      .fill("cedar");
    await page
      .getByLabel(`Resource ID for slot ${i + 1}`, { exact: true })
      .fill("north");
    await page
      .getByLabel(`UTC start for slot ${i + 1}`, { exact: true })
      .fill(`2035-01-0${i + 2}T12:00:00.000Z`);
    await page
      .getByLabel(`UTC end for slot ${i + 1}`, { exact: true })
      .fill(`2035-01-0${i + 2}T13:00:00.000Z`);
    if (i > 2)
      await page.getByLabel(`Time band for slot ${i + 1}`).selectOption("late");
  }
  await page
    .getByText("Candidate slots and team constraints", { exact: true })
    .click();
}
test("complete and partial schedules, manual edit invalidation, conflicts, reload and deliberate publishing", async ({
  page,
}) => {
  await open(page);
  await fill(page);
  await page
    .getByRole("button", { name: "Generate private draft", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Complete schedule", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/6 of 6 games assigned/)).toBeVisible();
  const rows = await db
      .collection(`organizations/${orgId}/scheduleDrafts`)
      .get(),
    saved = rows.docs[0];
  const first = page.getByRole("combobox", { name: /Slot for/ }).first();
  const secondSlot = await page
    .getByRole("combobox", { name: /Slot for/ })
    .nth(1)
    .inputValue();
  await first.selectOption(secondSlot);
  await expect(
    page.getByRole("heading", { name: "Fairness diagnostics", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Revalidate saved draft" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Save edits as unvalidated draft" })
    .click();
  await expect(page.getByText(/Saved private draft revision 2/)).toBeVisible();
  await expect(page.getByText(/Validation required/)).toBeVisible();
  await page.getByRole("button", { name: "Revalidate saved draft" }).click();
  await expect(
    page.getByRole("heading", { name: "Hard conflicts", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start publication" }),
  ).toBeDisabled();
  expect(
    (await db.collection("events").where("orgId", "==", orgId).get()).size,
  ).toBe(0);
  await page.reload();
  await page.getByLabel("Existing draft ID").fill(saved.id);
  await page.getByRole("button", { name: "Load draft", exact: true }).click();
  await expect(page.getByLabel("Division ID")).toBeDisabled();
  await expect(
    page.getByText("Validation required.", { exact: false }),
  ).toBeVisible();
  await page.reload();
  await fill(page, true);
  await page
    .getByRole("button", { name: "Generate private draft", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Partial or conflicting schedule" }),
  ).toBeVisible();
  await expect(
    page.getByText(/1 of 6 games assigned · 5 unscheduled/),
  ).toBeVisible();
  await expect(page.getByText(/Generation: impossible/)).toBeVisible();
});
test("uncertain generate retries exact action, stale save preserves correction, focus revocation discards late data", async ({
  page,
}) => {
  await open(page);
  await fill(page);
  const requests: unknown[] = [];
  let first = true;
  await page.route("**/generateScheduleDraft", async (route) => {
    requests.push(route.request().postDataJSON());
    if (first) {
      first = false;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page
    .getByRole("button", { name: "Generate private draft", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry same action" }),
  ).toBeVisible();
  await expect(page.getByLabel("Draft title")).toBeDisabled();
  await page.getByRole("button", { name: "Retry same action" }).click();
  await expect(
    page.getByRole("heading", { name: "Complete schedule", exact: true }),
  ).toBeVisible();
  expect(requests[0]).toEqual(requests[1]);
  const id = (requests[0] as { data: { draftId: string } }).data.draftId;
  await db
    .doc(`organizations/${orgId}/scheduleDrafts/${id}`)
    .update({ revision: 7 });
  await page.getByLabel("Draft title").fill("Correction retained");
  await page
    .getByRole("button", { name: "Save edits as unvalidated draft" })
    .click();
  await expect(page.getByRole("alert")).toContainText("record changed");
  await expect(page.getByLabel("Draft title")).toHaveValue(
    "Correction retained",
  );
  let release!: () => void, held!: () => void;
  const wait = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (held = r));
  const authorizationResponses = new Set<string>();
  await page.route(/\/(getAdminWorkspace|getSchedulePublication)$/, async (route) => {
    const response = await route.fetch();
    authorizationResponses.add(new URL(route.request().url()).pathname.split("/").at(-1)!);
    if (authorizationResponses.size === 2) held();
    await wait;
    await route.fulfill({ response });
  });
  await db
    .doc(`organizations/${orgId}/members/${uid}`)
    .update({ status: "revoked" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await ready;
  await page.getByLabel("Draft title").fill("Edit during revocation");
  release();
  await expect(page.getByRole("alert")).toContainText("Access unavailable");
  await expect(page.getByLabel("Draft title")).toHaveCount(0);
  await page.unrouteAll({ behavior: "wait" });
  await db
    .doc(`organizations/${orgId}/members/${uid}`)
    .update({ status: "active" });
});
test("live scheduler rollout revocation clears loaded private data on focus", async ({
  page,
}) => {
  await open(page);
  await fill(page);
  await page
    .getByRole("button", { name: "Generate private draft", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Complete schedule", exact: true }),
  ).toBeVisible();
  await db
    .doc(`organizations/${orgId}`)
    .update({ "features.scheduler": false });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("Access unavailable");
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await db.doc(`organizations/${orgId}`).update({ "features.scheduler": true });
});

test("labeled blackout and preference controls invalidate validation and expose current hard conflicts", async ({
  page,
}) => {
  await open(page);
  await fill(page);
  await page
    .getByRole("button", { name: "Generate private draft", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Complete schedule", exact: true }),
  ).toBeVisible();
  await page
    .getByText("Candidate slots and team constraints", { exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add team constraint", exact: true })
    .click();
  await page
    .getByLabel("Team for constraint 1", { exact: true })
    .selectOption("draft-a");
  await page
    .getByRole("button", { name: "Add blackout for constraint 1", exact: true })
    .click();
  await page
    .getByLabel("Blackout UTC start for constraint 1 interval 1")
    .fill("2035-01-02T00:00:00.000Z");
  await page
    .getByLabel("Blackout UTC end for constraint 1 interval 1")
    .fill("2035-01-08T00:00:00.000Z");
  await page
    .getByLabel("Prefer slot-1 for constraint 1", { exact: true })
    .check();
  await expect(
    page.getByRole("heading", { name: "Fairness diagnostics", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Save edits as unvalidated draft" })
    .click();
  await expect(page.getByText(/Saved private draft revision 2/)).toBeVisible();
  await page.getByRole("button", { name: "Revalidate saved draft" }).click();
  await expect(
    page.getByRole("heading", { name: "Hard conflicts", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Team blackout:/).first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("removing an assigned candidate slot clears its assignment and saves a truthful partial draft", async ({
  page,
}) => {
  await open(page);
  await fill(page);
  await page
    .getByRole("button", { name: "Generate private draft", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Complete schedule", exact: true }),
  ).toBeVisible();
  const firstFixture = page.getByRole("combobox", { name: /Slot for/ }).first();
  const slotId = await firstFixture.inputValue();
  await page
    .getByText("Candidate slots and team constraints", { exact: true })
    .click();
  await page
    .getByRole("button", {
      name: `Remove slot ${Number(slotId.split("-")[1])}`,
      exact: true,
    })
    .click();
  await page
    .getByText("Candidate slots and team constraints", { exact: true })
    .click();
  await expect(firstFixture).toHaveValue("");
  await expect(
    page.getByRole("heading", { name: "Fairness diagnostics", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Save edits as unvalidated draft" })
    .click();
  await expect(page.getByText(/Saved private draft revision 2/)).toBeVisible();
  await page.getByRole("button", { name: "Revalidate saved draft" }).click();
  await expect(
    page.getByText(/5 of 6 games assigned · 1 unscheduled/),
  ).toBeVisible();
});

test("accepted 1000-slot 32-team draft keeps editor and selector DOM bounded while preserving off-page choices", async ({
  page,
}) => {
  const extra = Array.from(
    { length: 28 },
    (_, i) => `draft-large-${String(i).padStart(2, "0")}`,
  );
  const scope = {
    orgId,
    programId: "draft-program",
    seasonId: "draft-season",
    divisionId: "draft-division",
  };
  for (const id of extra)
    await db
      .doc(`teams/${id}`)
      .set({ ...meta, ...scope, name: `Large team ${id}`, sport: "soccer" });
  const clientApp = require("firebase/app"),
    clientAuth = require("firebase/auth"),
    clientFunctions = require("firebase/functions");
  const client = clientApp.initializeApp(
    { projectId: "demo-team-hangout", apiKey: "demo-key" },
    "draft-capacity",
  );
  try {
    const auth = clientAuth.getAuth(client);
    clientAuth.connectAuthEmulator(auth, "http://127.0.0.1:9099", {
      disableWarnings: true,
    });
    await clientAuth.signInWithEmailAndPassword(
      auth,
      `${uid}@example.test`,
      password,
    );
    const functions = clientFunctions.getFunctions(client);
    clientFunctions.connectFunctionsEmulator(functions, "127.0.0.1", 5001);
    const start = Date.parse("2035-01-02T12:00:00.000Z");
    const slots = Array.from({ length: 1000 }, (_, i) => ({
      id: `slot-${i + 1}`,
      facilityId: "cedar",
      resourceId: "north",
      startsAt: new Date(start + i * 2 * 3600000).toISOString(),
      endsAt: new Date(start + i * 2 * 3600000 + 3600000).toISOString(),
      late: false,
    }));
    const teamIds = ["draft-a", "draft-b", "draft-c", "draft-d", ...extra];
    const result = (
      await clientFunctions.httpsCallable(
        functions,
        "generateScheduleDraft",
      )({
        orgId,
        divisionId: scope.divisionId,
        draftId: "capacity-draft",
        expectedRevision: 0,
        requestId: "capacity-generate",
        fields: {
          title: "Bounded full-size editor",
          startsAt: slots[0].startsAt,
          endsAt: slots.at(-1)!.endsAt,
          durationMinutes: 60,
          minimumRestMinutes: 60,
          repetitions: 1,
          seed: 206,
          slots,
          teamConstraints: teamIds.map((teamId) => ({
            teamId,
            blackouts: [],
            preferredSlotIds: ["slot-1000"],
          })),
        },
      })
    ).data;
    await open(page);
    await page.getByLabel("Existing draft ID").fill(result.draftId);
    await page.getByRole("button", { name: "Load draft", exact: true }).click();
    await expect(page.getByText(/Loaded revision 1/)).toBeVisible();
    await page
      .getByText("Candidate slots and team constraints", { exact: true })
      .click();
    expect(
      await page.getByRole("textbox", { name: /Facility ID for slot/ }).count(),
    ).toBe(10);
    expect(await page.locator("option").count()).toBeLessThan(2000);
    const selected = await page
      .getByRole("combobox", { name: /Slot for/ })
      .first()
      .inputValue();
    await page.getByLabel("Assignment slot page", { exact: true }).fill("50");
    await expect(
      page.getByRole("combobox", { name: /Slot for/ }).first(),
    ).toHaveValue(selected);
    await page.getByLabel("Candidate slot page", { exact: true }).fill("100");
    await expect(
      page.getByLabel("Facility ID for slot 1000", { exact: true }),
    ).toHaveValue("cedar");
    await page.getByLabel("Preference slot page", { exact: true }).fill("50");
    await expect(
      page.getByLabel("Prefer slot-1000 for constraint 1", { exact: true }),
    ).toBeChecked();
    await page
      .getByLabel("Prefer slot-1000 for constraint 1", { exact: true })
      .uncheck();
    await page
      .getByLabel("Prefer slot-999 for constraint 1", { exact: true })
      .check();
    await page
      .getByRole("button", { name: "Save edits as unvalidated draft" })
      .click();
    await expect(
      page.getByText(/Saved private draft revision 2/),
    ).toBeVisible();
    const saved = (
      await db.doc(`organizations/${orgId}/scheduleDrafts/capacity-draft`).get()
    ).data();
    expect(saved.fields.slots.length).toBe(1000);
    expect(saved.fields.teamConstraints.length).toBe(32);
    expect(saved.fields.teamConstraints[0].preferredSlotIds).toEqual([
      "slot-999",
    ]);
    expect(saved.fields.teamConstraints[1].preferredSlotIds).toEqual([
      "slot-1000",
    ]);
    expect(saved.assignments).toEqual(result.assignments);
  } finally {
    await clientApp.deleteApp(client);
    for (const id of extra) await db.doc(`teams/${id}`).delete();
  }
});

test("accepted 32-team draft with 128 blackouts per team pages interval controls and preserves hidden intervals", async ({
  page,
}) => {
  const extra = Array.from(
    { length: 28 },
    (_, i) => `draft-blackout-${String(i).padStart(2, "0")}`,
  );
  const scope = {
    orgId,
    programId: "draft-program",
    seasonId: "draft-season",
    divisionId: "draft-division",
  };
  for (const id of extra)
    await db
      .doc(`teams/${id}`)
      .set({ ...meta, ...scope, name: `Blackout team ${id}`, sport: "soccer" });
  const clientApp = require("firebase/app"),
    clientAuth = require("firebase/auth"),
    clientFunctions = require("firebase/functions");
  const client = clientApp.initializeApp(
    { projectId: "demo-team-hangout", apiKey: "demo-key" },
    "blackout-capacity",
  );
  try {
    const auth = clientAuth.getAuth(client);
    clientAuth.connectAuthEmulator(auth, "http://127.0.0.1:9099", {
      disableWarnings: true,
    });
    await clientAuth.signInWithEmailAndPassword(
      auth,
      `${uid}@example.test`,
      password,
    );
    const functions = clientFunctions.getFunctions(client);
    clientFunctions.connectFunctionsEmulator(functions, "127.0.0.1", 5001);
    const teamIds = ["draft-a", "draft-b", "draft-c", "draft-d", ...extra];
    const blocked = {
      startsAt: "2035-01-01T00:00:00.000Z",
      endsAt: "2035-04-01T00:00:00.000Z",
    };
    const result = (
      await clientFunctions.httpsCallable(
        functions,
        "generateScheduleDraft",
      )({
        orgId,
        divisionId: scope.divisionId,
        draftId: "blackout-capacity-draft",
        expectedRevision: 0,
        requestId: "blackout-capacity-generate",
        fields: {
          title: "Bounded blackout editor",
          startsAt: "2035-01-02T12:00:00.000Z",
          endsAt: "2035-01-02T13:00:00.000Z",
          durationMinutes: 60,
          minimumRestMinutes: 60,
          repetitions: 1,
          seed: 206,
          slots: [
            {
              id: "slot-1",
              facilityId: "cedar",
              resourceId: "north",
              startsAt: "2035-01-02T12:00:00.000Z",
              endsAt: "2035-01-02T13:00:00.000Z",
              late: false,
            },
          ],
          teamConstraints: teamIds.map((teamId) => ({
            teamId,
            blackouts: Array.from({ length: 128 }, () => ({ ...blocked })),
            preferredSlotIds: [],
          })),
        },
      })
    ).data;
    await open(page);
    await page.getByLabel("Existing draft ID").fill(result.draftId);
    await page.getByRole("button", { name: "Load draft", exact: true }).click();
    await expect(page.getByText(/Loaded revision 1/)).toBeVisible();
    await page
      .getByText("Candidate slots and team constraints", { exact: true })
      .click();
    expect(
      await page
        .getByRole("textbox", { name: /Blackout UTC start for constraint/ })
        .count(),
    ).toBe(160);
    expect(await page.locator("input").count()).toBeLessThan(500);
    await page
      .getByLabel("Blackout page for constraint 1", { exact: true })
      .fill("26");
    await expect(
      page.getByLabel("Blackout UTC start for constraint 1 interval 128", {
        exact: true,
      }),
    ).toHaveValue(blocked.startsAt);
    await page
      .getByLabel("Blackout UTC start for constraint 1 interval 128", {
        exact: true,
      })
      .fill("2035-01-01T00:01:00.000Z");
    await page
      .getByRole("button", { name: "Save edits as unvalidated draft" })
      .click();
    await expect(
      page.getByText(/Saved private draft revision 2/),
    ).toBeVisible();
    const saved = (
      await db
        .doc(`organizations/${orgId}/scheduleDrafts/blackout-capacity-draft`)
        .get()
    ).data();
    expect(saved.fields.teamConstraints.length).toBe(32);
    expect(
      saved.fields.teamConstraints.every(
        (t: any) => t.blackouts.length === 128,
      ),
    ).toBe(true);
    expect(saved.fields.teamConstraints[0].blackouts[0]).toEqual(blocked);
    expect(saved.fields.teamConstraints[0].blackouts[127].startsAt).toBe(
      "2035-01-01T00:01:00.000Z",
    );
    expect(saved.fields.teamConstraints[1].blackouts[127]).toEqual(blocked);
    expect(saved.validation).toBeNull();
  } finally {
    await clientApp.deleteApp(client);
    for (const id of extra) await db.doc(`teams/${id}`).delete();
  }
});

test("deliberate publication recovers an uncertain chunk, reloads progress and commits the complete batch", async ({ page }) => {
  await open(page);
  await fill(page);
  await page.getByRole("button", { name: "Generate private draft", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Complete schedule", exact: true })).toBeVisible();
  const start = page.getByRole("button", { name: "Start publication" });
  await expect(start).toBeDisabled();
  await page.getByLabel("I have reviewed this complete schedule and want to publish it.").check();
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByText("Staged 0 of 6 · Promoted 0 of 6")).toBeVisible();
  const requests: unknown[] = [];
  let lost = true;
  await page.route("**/advanceSchedulePublication", async route => {
    requests.push(route.request().postDataJSON());
    if (lost) { lost = false; await route.fetch(); await route.abort("failed"); }
    else await route.continue();
  });
  await page.getByRole("button", { name: "Continue next chunk" }).click();
  await expect(page.getByRole("button", { name: "Retry same publication action" })).toBeVisible();
  await page.getByRole("button", { name: "Retry same publication action" }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[0]).toEqual(requests[1]);
  await expect(page.getByText("Staged 6 of 6 · Promoted 0 of 6")).toBeVisible();
  const rows = await db.collection(`organizations/${orgId}/scheduleOperations`).get();
  const op = rows.docs.find((r: { data: () => { state: string } }) => r.data().state === "promoting")!;
  await page.reload();
  await page.getByLabel("Existing draft ID").fill(op.data().draftId);
  await page.getByRole("button", { name: "Load draft", exact: true }).click();
  await expect(page.getByText("Staged 6 of 6 · Promoted 0 of 6")).toBeVisible();
  await page.getByRole("button", { name: "Resume interrupted publication" }).click();
  await page.getByRole("button", { name: "Continue next chunk" }).click();
  await expect(page.getByRole("button", { name: "Verify and commit publication" })).toBeVisible();
  expect((await db.collection(`organizations/${orgId}/outbox`).get()).size).toBe(0);
  await page.getByRole("button", { name: "Verify and commit publication" }).click();
  await expect(page.getByText("Published. The complete schedule is available to authorized teams and households.")).toBeVisible();
  expect((await db.collection(`organizations/${orgId}/outbox`).get()).size).toBe(1);
});

test("abort then save and revalidate restarts publication without focus or reload", async ({ page }) => {
  await open(page);
  await fill(page);
  await page.getByLabel("Range start (UTC)", { exact: true }).fill("2035-02-02T12:00:00.000Z");
  await page.getByLabel("Range end (UTC, exclusive)", { exact: true }).fill("2035-02-07T13:00:00.000Z");
  await page.getByText("Candidate slots and team constraints", { exact: true }).click();
  for (let i = 0; i < 6; i++) {
    await page.getByLabel(`UTC start for slot ${i + 1}`, { exact: true }).fill(`2035-02-0${i + 2}T12:00:00.000Z`);
    await page.getByLabel(`UTC end for slot ${i + 1}`, { exact: true }).fill(`2035-02-0${i + 2}T13:00:00.000Z`);
  }
  await page.getByText("Candidate slots and team constraints", { exact: true }).click();
  await page.getByRole("button", { name: "Generate private draft", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Complete schedule", exact: true })).toBeVisible();
  await page.getByLabel("I have reviewed this complete schedule and want to publish it.").check();
  await page.getByRole("button", { name: "Start publication", exact: true }).click();
  await expect(page.getByText("Staged 0 of 6 · Promoted 0 of 6")).toBeVisible();
  await page.getByRole("button", { name: "Abort hidden publication", exact: true }).click();
  await expect(page.getByText("Publication aborted. Batch events remain hidden.")).toBeVisible();
  await page.getByLabel("Draft title", { exact: true }).fill("Reviewed after abort");
  await page.getByRole("button", { name: "Save edits as unvalidated draft", exact: true }).click();
  await page.getByRole("button", { name: "Revalidate saved draft", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Complete schedule", exact: true })).toBeVisible();
  await page.getByLabel("I have reviewed this complete schedule and want to publish it.").check();
  await page.getByRole("button", { name: "Start publication", exact: true }).click();
  await expect(page.getByText("Staged 0 of 6 · Promoted 0 of 6")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue next chunk", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Abort hidden publication", exact: true }).click();
});
