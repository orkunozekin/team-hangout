import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../functions/package.json", import.meta.url),
);
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
if (
  process.env.ADMIN_EMULATOR_TESTS !== "1" ||
  process.env.GCLOUD_PROJECT !== "demo-team-hangout" ||
  process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8080"
)
  throw new Error("Use the isolated admin emulator harness.");
test.describe.configure({ mode: "serial" });
let app: ReturnType<typeof initializeApp>, db: ReturnType<typeof getFirestore>;
const password = "SyntheticPassword123!",
  uid = "closure-owner",
  orgId = "browser-closures";
const at = (day: number, hour = 0) =>
  `2035-01-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`;
const meta = { schemaVersion: 2, status: "active", revision: 1 };
async function seed(count = 1) {
  await db
    .doc(`organizations/${orgId}/schedulingLock/current`)
    .set({ operationId: null });
  await db
    .doc(`organizations/${orgId}/members/${uid}`)
    .set({ ...meta, orgId, roles: ["orgAdmin"], programIds: [] });
  const previous = await db
    .collection("events")
    .where("orgId", "==", orgId)
    .get();
  for (const row of previous.docs) await db.recursiveDelete(row.ref);
  // Each test uses a unique facility so retained closure history cannot alter another scenario.
  const facilityId = `park-${Date.now()}`;
  await db
    .doc(`organizations/${orgId}/facilities/${facilityId}`)
    .set({
      ...meta,
      orgId,
      name: facilityId,
      address: "100 Sample Street",
      timeZone: "UTC",
      latitude: null,
      longitude: null,
      parking: null,
      accessibility: null,
    });
  await db
    .doc(`organizations/${orgId}/facilities/${facilityId}/resources/field`)
    .set({
      ...meta,
      orgId,
      facilityId,
      label: "Field 2 North",
      sports: ["soccer"],
      setupMinutes: 15,
      cleanupMinutes: 10,
    });
  await db
    .doc(
      `organizations/${orgId}/facilities/${facilityId}/resources/field/availability/1`,
    )
    .set({
      schemaVersion: 2,
      orgId,
      facilityId,
      resourceId: "field",
      revision: 1,
      effectiveFrom: at(1),
      windows: [{ startsAt: at(1), endsAt: at(31, 23) }],
    });
  const events: string[] = [];
  for (let i = 0; i < count; i++) {
    const eventId = `${facilityId}-event-${i}`;
    events.push(eventId);
    await db
      .doc(`events/${eventId}`)
      .set({
        ...meta,
        orgId,
        programId: "closure-program",
        seasonId: "closure-season",
        divisionId: "closure-division",
        teamId: "closure-a",
        teamIds: ["closure-a", "closure-b"],
        homeTeamId: "closure-a",
        awayTeamId: "closure-b",
        title: `Falcons vs Comets ${i + 1}`,
        type: "match",
        status: "scheduled",
        publicationState: "published",
        publicationOperationId: null,
        startsAt: Timestamp.fromDate(new Date(at(2 + i, 23))),
        endsAt: Timestamp.fromDate(new Date(at(3 + i))),
        timeZone: "UTC",
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
        createdBy: uid,
        updatedBy: uid,
        scheduleVersion: 1,
        deletedAt: null,
        facilityId,
        resourceId: "field",
        location: {
          name: "Cedar Park · Field 2 North",
          address: "100 Sample Street",
        },
        resourceOccupancy: {
          startsAt: Timestamp.fromDate(new Date(at(2 + i, 23))),
          endsAt: Timestamp.fromMillis(Date.parse(at(3 + i)) + 10 * 60000),
          setupMinutes: 15,
          cleanupMinutes: 10,
          sports: ["soccer"],
          availabilityRevision: 1,
          resourceRevision: 1,
        },
      });
  }
  return { facilityId, events };
}
async function open(page: Page, f: string) {
  await page.goto(`/organizations/${orgId}/closures`);
  await page.getByLabel("Email address").fill(`${uid}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Facility", { exact: true }).selectOption(f);
  await page.getByLabel("Starts at (UTC)").fill(at(3));
  await page.getByLabel("Ends at (UTC)").fill(at(3, 2));
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Staff reviewed unsafe field");
}
test.beforeAll(async () => {
  app = initializeApp({ projectId: "demo-team-hangout" });
  db = getFirestore(app);
  await getAuth(app).createUser({
    uid,
    email: `${uid}@example.test`,
    password,
  });
  await db.doc(`users/${uid}`).set({ uid, appRole: "user" });
  await db
    .doc(`organizations/${orgId}`)
    .set({
      ...meta,
      name: "Cedar Park Athletics",
      timeZone: "UTC",
      features: { organizationV2: true, adminWorkspace: true },
    });
  for (const [kind, id] of [
    ["programs", "closure-program"],
    ["seasons", "closure-season"],
    ["divisions", "closure-division"],
  ])
    await db
      .doc(`organizations/${orgId}/${kind}/${id}`)
      .set({
        ...meta,
        orgId,
        programId: "closure-program",
        seasonId: "closure-season",
        name: id,
        sportCode: "soccer",
        timeZone: "UTC",
        startsOn: "2035-01-01",
        endsOn: "2035-01-31",
      });
  for (const [teamId, name] of [
    ["closure-a", "Falcons"],
    ["closure-b", "Comets"],
  ])
    await db
      .doc(`teams/${teamId}`)
      .set({
        ...meta,
        orgId,
        programId: "closure-program",
        seasonId: "closure-season",
        divisionId: "closure-division",
        name,
        sport: "soccer",
      });
});
test.afterAll(async () => {
  await deleteApp(app);
});
test("review impact, immediate pending state, lost chunk response, reload and deliberate reviewed makeup preserve identity", async ({
  page,
}) => {
  const f = await seed();
  await open(page, f.facilityId);
  await page
    .getByRole("button", { name: "Preview closure impact", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Affected teams and events" }),
  ).toBeVisible();
  await expect(
    page.getByText("Falcons · Comets", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Apply reviewed closure" }),
  ).toBeDisabled();
  await page.getByLabel("I reviewed the affected teams").check();
  await page.getByRole("button", { name: "Apply reviewed closure" }).click();
  await expect(
    page.getByText("Resource closed. Postponement update pending."),
  ).toBeVisible();
  let payload: string | null = null,
    requests: string[] = [];
  await page.route("**/advanceFacilityClosure", async (route) => {
    requests.push(route.request().postData()!);
    if (payload === null) {
      payload = route.request().postData();
      await route.fetch();
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { status: "UNAVAILABLE", message: "Synthetic lost result" },
        }),
      });
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Continue next event" }).click();
  await expect(
    page.getByRole("button", { name: "Retry same action", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Starts at (UTC)")).toBeDisabled();
  await page
    .getByRole("button", { name: "Retry same action", exact: true })
    .click();
  await expect(
    page.getByText("Postponed. Awaiting a reviewed makeup."),
  ).toBeVisible();
  expect(requests[1]).toBe(payload);
  const stored = (await db.doc(`events/${f.events[0]}`).get()).data();
  expect(stored.revision).toBe(2);
  await page.getByRole("button", { name: "Reload closure progress" }).click();
  await expect(
    page.getByText("Postponed. Awaiting a reviewed makeup."),
  ).toBeVisible();
  await page.getByLabel("Starts at (UTC)").fill(at(20, 12));
  await page.getByLabel("Ends at (UTC)").fill(at(20, 13));
  await page.getByLabel("Resource", { exact: true }).selectOption("field");
  await page.getByLabel("Postponed event ID").fill(f.events[0]);
  await page
    .getByRole("button", { name: "Preview makeup", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Makeup preview: Falcons vs Comets 1" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm reviewed makeup" }),
  ).toBeDisabled();
  await page.getByLabel("I reviewed this makeup").check();
  await page.getByRole("button", { name: "Confirm reviewed makeup" }).click();
  await expect(
    page.getByText("Makeup confirmed.", { exact: false }),
  ).toBeVisible();
  const moved = (await db.doc(`events/${f.events[0]}`).get()).data();
  expect(moved.status).toBe("scheduled");
  expect(moved.scheduleVersion).toBe(2);
  expect(moved.originalInterval.startsAt.toDate().toISOString()).toBe(
    at(2, 23),
  );
});
test("changed preview requires renewed review and inputs invalidate previous confirmation", async ({
  page,
}) => {
  const f = await seed();
  await open(page, f.facilityId);
  await page.getByRole("button", { name: "Preview closure impact" }).click();
  await page.getByLabel("I reviewed the affected teams").check();
  await db
    .doc(`events/${f.events[0]}`)
    .update({ revision: 2, title: "Staff changed event" });
  await page.getByRole("button", { name: "Apply reviewed closure" }).click();
  await expect(page.getByRole("alert")).toContainText("changed");
  await page
    .getByLabel("Reason", { exact: true })
    .fill("A revised staff reason");
  await expect(
    page.getByRole("heading", { name: "Affected teams and events" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Preview closure impact" }).click();
  await expect(
    page.getByRole("button", { name: "Apply reviewed closure" }),
  ).toBeDisabled();
});
test("impact lists are paged, midnight events stay visible and narrow screens do not overflow", async ({
  page,
}) => {
  const f = await seed(12);
  await open(page, f.facilityId);
  await page.getByLabel("Ends at (UTC)").fill(at(16));
  await page.getByRole("button", { name: "Preview closure impact" }).click();
  const panel = page.getByRole("region", { name: "Closure impact" });
  await expect(panel.locator("article")).toHaveCount(10);
  await panel.getByRole("button", { name: "More impacts" }).click();
  await expect(panel.locator("article")).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("focus revocation discards closure data and prevents actions", async ({
  page,
}) => {
  const f = await seed();
  await open(page, f.facilityId);
  await page.getByRole("button", { name: "Preview closure impact" }).click();
  await expect(
    page.getByRole("heading", { name: "Affected teams and events" }),
  ).toBeVisible();
  await db
    .doc(`organizations/${orgId}/members/${uid}`)
    .update({ status: "revoked" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByRole("heading", { name: "Affected teams and events" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Preview closure impact" }),
  ).toBeDisabled();
});
