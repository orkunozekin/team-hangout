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
const orgId = "browser-facilities",
  password = "SyntheticPassword123!";
const meta = { schemaVersion: 2, revision: 1, status: "active" };
async function open(page: Page, uid = "facilities-owner") {
  await page.goto(`/organizations/${orgId}/facility`);
  await page.getByLabel("Email address").fill(`${uid}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
test.beforeAll(async () => {
  app = initializeApp({ projectId: "demo-team-hangout" });
  db = getFirestore(app);
  for (const uid of [
    "facilities-owner",
    "facilities-staff",
    "facilities-outsider",
  ]) {
    await getAuth(app).createUser({
      uid,
      email: `${uid}@example.test`,
      password,
    });
    await db.doc(`users/${uid}`).set({ uid, appRole: "user" });
  }
  await db
    .doc(`organizations/${orgId}`)
    .set({
      ...meta,
      name: "Cedar Park Athletics",
      timeZone: "America/Chicago",
      features: { organizationV2: true, adminWorkspace: true },
    });
  await db
    .doc(`organizations/${orgId}/members/facilities-owner`)
    .set({ ...meta, orgId, roles: ["orgAdmin"], programIds: [] });
  await db
    .doc(`organizations/${orgId}/members/facilities-staff`)
    .set({
      ...meta,
      orgId,
      roles: ["programStaff"],
      programIds: ["facilities-program"],
    });
  for (const [kind, id] of [
    ["programs", "facilities-program"],
    ["seasons", "facilities-season"],
    ["divisions", "facilities-division"],
  ])
    await db
      .doc(`organizations/${orgId}/${kind}/${id}`)
      .set({
        ...meta,
        orgId,
        programId: "facilities-program",
        seasonId: "facilities-season",
        name: id,
        sportCode: "soccer",
      });
  await db
    .doc("teams/facilities-team")
    .set({
      ...meta,
      orgId,
      programId: "facilities-program",
      seasonId: "facilities-season",
      divisionId: "facilities-division",
      sport: "soccer",
      name: "Falcons",
    });
  for (const id of ["facilities-event", "facilities-conflict"])
    await db
      .doc(`events/${id}`)
      .set({
        ...meta,
        orgId,
        programId: "facilities-program",
        seasonId: "facilities-season",
        divisionId: "facilities-division",
        teamId: "facilities-team",
        teamIds: ["facilities-team"],
        title:
          id === "facilities-event" ? "Falcons training" : "Comets training",
        type: "practice",
        timeZone: "America/Chicago",
        startsAt: Timestamp.fromDate(new Date("2035-01-02T12:00:00.000Z")),
        endsAt: Timestamp.fromDate(new Date("2035-01-02T13:00:00.000Z")),
        publicationState: "published",
        publicationOperationId: null,
        status: "scheduled",
        deletedAt: null,
        location: null,
      });
});
test.afterAll(async () => {
  await deleteApp(app);
});
test("staff creates exact resources, availability, assigns an event and sees real overlap and stale errors", async ({
  page,
}) => {
  await open(page);
  await expect(
    page.getByText("No facilities yet.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "New facility", exact: true }).click();
  await page.getByLabel("Facility name", { exact: true }).fill("Cedar Park");
  await page.getByLabel("Street address").fill("100 Sample Street");
  await page.getByLabel("IANA time zone").fill("America/Chicago");
  await page
    .getByLabel("Parking instructions")
    .fill("East lot, enter from Sample Street.");
  await page
    .getByLabel("Accessibility instructions")
    .fill("Step-free entrance beside Field 2 North.");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByRole("button", { name: "Details and resources for Cedar Park" })
    .click();
  await expect(page.getByText("No fields or courts yet.")).toBeVisible();
  await page.getByRole("button", { name: "New field or court" }).click();
  await page.getByLabel("Exact field or court label").fill("Field 2 North");
  await page.getByLabel("Setup minutes").fill("15");
  await page.getByLabel("Cleanup minutes").fill("10");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByRole("button", {
      name: "Availability and assignment for Field 2 North",
    })
    .click();
  await expect(
    page.getByText("Unavailable until an availability revision is added."),
  ).toBeVisible();
  await page
    .getByLabel("Effective from (UTC)")
    .fill("2035-01-01T00:00:00.000Z");
  await page
    .getByLabel("Availability windows")
    .fill("2035-01-01T00:00:00.000Z,2035-01-10T00:00:00.000Z");
  await page.getByRole("button", { name: "Add availability revision" }).click();
  await expect(page.getByLabel("Effective from (UTC)")).toHaveCount(0);
  await page
    .getByRole("button", {
      name: "Availability and assignment for Field 2 North",
    })
    .click();
  await expect(
    page.getByRole("heading", { name: /Revision 2, effective/ }),
  ).toBeVisible();
  await page.getByLabel("Event ID", { exact: true }).fill("facilities-event");
  await page.getByRole("button", { name: "Load event for assignment" }).click();
  await expect(
    page.getByText("Falcons training · Current location: Unassigned"),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Assign to Field 2 North", exact: true })
    .click();
  await expect(
    page.getByText("Assignment saved.", { exact: true }),
  ).toBeVisible();
  const stored = (await db.doc("events/facilities-event").get()).data();
  expect(stored.location.name).toBe("Cedar Park · Field 2 North");
  expect(stored.resourceOccupancy.setupMinutes).toBe(15);
  await page
    .getByLabel("Event ID", { exact: true })
    .fill("facilities-conflict");
  await page.getByRole("button", { name: "Load event for assignment" }).click();
  await page
    .getByRole("button", { name: "Assign to Field 2 North", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: "overlapping reservation" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit Field 2 North", exact: true })
    .click();
  await db
    .doc(
      `organizations/${orgId}/facilities/${stored.facilityId}/resources/${stored.resourceId}`,
    )
    .update({ revision: 3 });
  await page
    .getByLabel("Exact field or court label")
    .fill("Field 2 North revised");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "changed while you were editing" }),
  ).toBeVisible();
  await expect(page.getByLabel("Exact field or court label")).toHaveValue(
    "Field 2 North revised",
  );
  // Seed a second physical resource with a truthful unavailable state for the representative view.
  await db
    .doc(
      `organizations/${orgId}/facilities/${stored.facilityId}/resources/court-west`,
    )
    .set({
      ...meta,
      orgId,
      facilityId: stored.facilityId,
      label: "Court 1 West",
      sports: ["basketball"],
      setupMinutes: 5,
      cleanupMinutes: 5,
      status: "inactive",
    });
  await page.getByRole("button", { name: "Reload facilities" }).click();
  await page
    .getByRole("button", { name: "Details and resources for Cedar Park" })
    .click();
  await expect(
    page.getByText(/Unavailable resource · basketball/),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open map for Cedar Park (new tab)" }),
  ).toHaveAttribute("href", /query=100%20Sample%20Street/);
});
test("program staff read shared safe catalog without catalog writes; revocation clears visible data", async ({
  page,
}) => {
  await open(page, "facilities-staff");
  await expect(
    page.getByRole("button", { name: "New facility", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Details and resources for Cedar Park" })
    .click();
  await expect(page.getByText("Court 1 West", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New field or court" }),
  ).toHaveCount(0);
  await db
    .doc(`organizations/${orgId}/members/facilities-staff`)
    .update({ status: "revoked" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("Access unavailable");
  await expect(page.getByText("Court 1 West", { exact: true })).toHaveCount(0);
});
test("outsider direct URL and unavailable load are handled without catalog data", async ({
  page,
}) => {
  await open(page, "facilities-outsider");
  await expect(page.getByRole("alert")).toContainText("Access unavailable");
  await expect(page.getByText("Cedar Park", { exact: true })).toHaveCount(0);
});
