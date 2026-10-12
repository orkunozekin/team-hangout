import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const require = createRequire(
  new URL("../../functions/package.json", import.meta.url),
);
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
if (
  process.env.ADMIN_EMULATOR_TESTS !== "1" ||
  process.env.GCLOUD_PROJECT !== "demo-team-hangout" ||
  process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8080" ||
  process.env.FIREBASE_AUTH_EMULATOR_HOST !== "127.0.0.1:9099"
) {
  throw new Error(
    "Run only through yarn test:admin with the isolated demo emulators.",
  );
}
test.describe.configure({ mode: "serial" });
const password = "SyntheticPassword123!";
let app: ReturnType<typeof initializeApp>, db: ReturnType<typeof getFirestore>;
const orgId = "browser-demo-club";
const evidence = process.env.ADMIN_EVIDENCE_DIR;
async function capture(page: Page, name: string) {
  if (evidence) {
    await page.evaluate(async () => {
      window.scrollTo(0, 0);
      await document.fonts.ready;
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    await mkdir(evidence, { recursive: true });
    await page.screenshot({
      path: path.join(evidence, `${name}.png`),
      fullPage: true,
    });
  }
}
async function login(page: Page, user = "browser-owner") {
  await page.getByLabel("Email address").fill(`${user}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
async function open(
  page: Page,
  section = "program",
  user = "browser-owner",
  query = "",
) {
  await page.goto(`/organizations/${orgId}/${section}${query}`);
  await login(page, user);
}
async function newRecord(page: Page, kind: string, name: string) {
  await page.getByRole("button", { name: `New ${kind}`, exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
}
async function saved(page: Page, name: string) {
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.locator("td strong").filter({ hasText: name }),
  ).toBeVisible();
}
test.beforeAll(async () => {
  app = initializeApp({ projectId: "demo-team-hangout" });
  db = getFirestore(app);
  for (const user of ["browser-owner", "browser-staff", "browser-outsider"]) {
    await getAuth(app).createUser({
      uid: user,
      email: `${user}@example.test`,
      password,
    });
    await db.doc(`users/${user}`).set({ uid: user, appRole: "user" });
  }
  const meta = {
    schemaVersion: 2,
    revision: 1,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    createdBy: "browser-owner",
    updatedBy: "browser-owner",
  };
  await db.doc(`organizations/${orgId}`).set({
    ...meta,
    name: "Cedar Park Athletics",
    kind: "communityCenter",
    timeZone: "America/Chicago",
    status: "active",
    features: { organizationV2: true, adminWorkspace: true },
  });
  await db.doc(`organizations/${orgId}/members/browser-owner`).set({
    ...meta,
    orgId,
    roles: ["orgAdmin"],
    programIds: [],
    status: "active",
  });
  await db
    .doc(`users/browser-owner/organizationLinks/${orgId}`)
    .set({ orgId, status: "active" });
  await db.doc(`organizations/${orgId}/programs/soccer`).set({
    ...meta,
    orgId,
    name: "Youth soccer",
    sportCode: "soccer",
    sportLabel: null,
    status: "active",
  });
  await db.doc(`organizations/${orgId}/members/browser-staff`).set({
    ...meta,
    orgId,
    roles: ["programStaff"],
    programIds: ["soccer"],
    status: "active",
  });
  await db
    .doc(`users/browser-staff/organizationLinks/${orgId}`)
    .set({ orgId, status: "active" });
});
test.afterAll(async () => {
  await deleteApp(app);
});

test("real browser sign-in, hierarchy creation, archive/restore, conflict and staff management", async ({
  page,
}) => {
  await page.goto(`/organizations/${orgId}/team`);
  await expect(
    page.getByRole("heading", { name: "Welcome back." }),
  ).toBeVisible();
  await capture(page, "01-sign-in");
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/getAdminWorkspace", async (route) => {
    await gate;
    await route.continue();
  });
  await login(page);
  await expect(page.getByRole("status")).toContainText("Authorizing workspace");
  await capture(page, "00-authorizing");
  release();
  await expect(
    page.getByRole("heading", { name: "No teams to show" }),
  ).toBeVisible();
  await capture(page, "02-empty-teams");
  await page.getByRole("link", { name: "Programs", exact: true }).click();
  const hierarchyReads: string[] = [];
  page.on("request", (request) => {
    if (
      request.url().endsWith("/listOrganizationHierarchy") &&
      request.method() === "POST"
    )
      hierarchyReads.push(request.postDataJSON().data.kind);
  });
  await newRecord(page, "program", "Community basketball");
  const reauthorized = page.waitForResponse(
    (response) =>
      response.url().endsWith("/getAdminWorkspace") &&
      response.request().method() === "POST",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await reauthorized;
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Community basketball",
  );
  expect(hierarchyReads.filter((kind) => kind !== "program")).toEqual([]);
  await page
    .getByRole("combobox", { name: "Sport", exact: true })
    .selectOption("basketball");
  let intercepted = false;
  await page.route("**/saveHierarchyEntity", async (route) => {
    if (intercepted || route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    intercepted = true;
    await route.fetch(); // The real server commits; only the response is lost.
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry same action" }),
  ).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toBeDisabled();
  const retryFocus = page.waitForResponse(
    (response) =>
      response.url().endsWith("/getAdminWorkspace") &&
      response.request().method() === "POST",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await retryFocus;
  await expect(
    page.getByRole("button", { name: "Retry same action" }),
  ).toBeVisible();
  await capture(page, "11-retained-retry");
  await page.getByRole("button", { name: "Retry same action" }).click();
  await expect(
    page.locator("td strong").filter({ hasText: "Community basketball" }),
  ).toHaveCount(1);
  expect(
    (
      await db
        .collection(`organizations/${orgId}/programs`)
        .where("name", "==", "Community basketball")
        .get()
    ).size,
  ).toBe(1);
  await page.getByRole("link", { name: "Seasons", exact: true }).click();
  await newRecord(page, "season", "Fall 2026");
  await page
    .getByRole("region", { name: "Record editor" })
    .getByRole("combobox", { name: "Program", exact: true })
    .selectOption("soccer");
  await page.getByLabel("Starts on").fill("2026-09-01");
  await page.getByLabel("Ends on").fill("2026-12-01");
  await saved(page, "Fall 2026");
  await expect(page.locator("tbody")).toContainText("Tuesday, Sep 1");
  await expect(page.locator("tbody")).toContainText("Tuesday, Dec 1");
  await capture(page,"refinement-season-dates");
  await page.getByRole("link", { name: "Divisions", exact: true }).click();
  await newRecord(page, "division", "Under 12");
  const editor = page.getByRole("region", { name: "Record editor" });
  await editor
    .getByRole("combobox", { name: "Program", exact: true })
    .selectOption("soccer");
  await editor
    .getByRole("combobox", { name: "Season", exact: true })
    .selectOption({ label: "Fall 2026" });
  await page.getByLabel("Age band (optional)").fill("Ages 10–12");
  await saved(page, "Under 12");
  await page.getByRole("link", { name: "Teams", exact: true }).click();
  await newRecord(page, "team", "Cedar Park Wolves");
  await editor
    .getByRole("combobox", { name: "Program", exact: true })
    .selectOption("soccer");
  await editor
    .getByRole("combobox", { name: "Season", exact: true })
    .selectOption({ label: "Fall 2026" });
  await editor
    .getByRole("combobox", { name: "Division", exact: true })
    .selectOption({ label: "Under 12" });
  await saved(page, "Cedar Park Wolves");
  await capture(page, "03-team-created");
  await page
    .getByRole("button", { name: "Edit Cedar Park Wolves", exact: true })
    .click();
  await expect(
    editor.getByRole("combobox", { name: "Division", exact: true }),
  ).toBeDisabled();
  const teamSnap = await db
    .collection("teams")
    .where("orgId", "==", orgId)
    .get();
  await teamSnap.docs[0].ref.update({
    revision: 2,
    name: "Cedar Park Wolves updated elsewhere",
  });
  await page.getByLabel("Name", { exact: true }).fill("Stale overwrite");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("This record changed");
  await capture(page, "04-conflict");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(page.locator("td strong")).toContainText("updated elsewhere");
  await page.getByRole("link", { name: "Seasons", exact: true }).click();
  await page.getByRole("button", { name: "Edit Fall 2026" }).click();
  await page
    .getByRole("button", { name: "Archive season", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "No seasons to show" }),
  ).toBeVisible();
  await page.getByLabel("Include archived / revoked").check();
  await expect(page.locator("tbody .badge")).toHaveText("archived");
  await capture(page, "05-season-archived");
  await page.getByRole("button", { name: "Edit Fall 2026" }).click();
  await page.getByRole("button", { name: "Restore season to active" }).click();
  await expect(page.locator("tbody .badge")).toHaveText("active");
  hierarchyReads.length = 0;
  await page.getByRole("link", { name: "Staff access", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit browser-staff", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Access status", exact: true })
    .selectOption("revoked");
  await saved(page, "browser-owner");
  await page.getByLabel("Include archived / revoked").check();
  await expect(
    page.getByRole("row").filter({ hasText: "browser-staff" }),
  ).toContainText("revoked");
  await capture(page, "06-staff-revoked");
  await page
    .getByRole("button", { name: "Edit browser-staff", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Access status", exact: true })
    .selectOption("active");
  await saved(page, "browser-staff");
  await page
    .getByRole("link", { name: "Organization settings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Edit Cedar Park Athletics", exact: true })
    .click();
  await page
    .getByLabel("Name", { exact: true })
    .fill("Cedar Park Community Athletics");
  await saved(page, "Cedar Park Community Athletics");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await login(page, "browser-outsider");
  await expect(
    page.getByRole("heading", { name: "No staff access yet" }),
  ).toBeVisible();
  await capture(page, "07-no-staff-access");
  await page.goto(`/organizations/${orgId}/team`);
  await expect(page.getByRole("alert")).toContainText("Access unavailable");
  await expect(
    page.getByText("Cedar Park Wolves updated elsewhere"),
  ).toHaveCount(0);
  await capture(page, "08-direct-url-denied");
});

test("program staff direct URLs reauthorize on reload and never load unrelated programs", async ({
  page,
}) => {
  await open(page, "season", "browser-staff");
  await expect(
    page.getByRole("heading", { name: "Choose a program", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Program", exact: true })
    .selectOption("soccer");
  await expect(page.locator("td strong")).toHaveText("Fall 2026");
  await expect(
    page.getByRole("link", { name: "Staff access", exact: true }),
  ).toHaveCount(0);
  await capture(page, "09-program-staff");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    )
    .toBeLessThanOrEqual(0);
  const menu = page.getByRole("button", { name: "Open menu", exact: true });
  const navigation = page.getByRole("navigation", { name: "Organization" });
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(navigation).toBeHidden();
  await expect(page.locator(".date-range time")).toHaveText([
    "Tuesday, Sep 1",
    "Tuesday, Dec 1",
  ]);
  await capture(page, "10-small-browser");
  await menu.click();
  await expect(navigation).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close menu" }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".menu-icon > span").nth(1)).toHaveCSS(
    "opacity",
    "0",
  );
  await capture(page, "12-mobile-navigation");
  await page.getByRole("button", { name: "Close menu" }).press("Enter");
  await expect(navigation).toBeHidden();
  await expect(page.locator(".menu-icon > span").nth(1)).toHaveCSS(
    "opacity",
    "1",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await menu.click();
  await expect(navigation).toBeVisible();
  await expect(page.locator(".menu-icon > span").first()).toHaveCSS(
    "transition-duration",
    "0s",
  );
  await navigation.getByRole("link", { name: "Seasons", exact: true }).click();
  await expect(navigation).toBeHidden();
  await expect(page.locator("td strong")).toHaveText("Fall 2026");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await expect(page.locator("td strong")).toHaveText("Fall 2026");
  await page.goto(`/organizations/${orgId}/team?program=unassigned-program`);
  await expect(page.getByRole("alert")).toContainText("Access unavailable");
  await page.goto(`/organizations/${orgId}/staff`);
  await expect(page.getByRole("alert")).toContainText("Access unavailable");
  await page.goto(`/organizations/${orgId}/season?program=soccer`);
  await expect(page.locator("td strong")).toHaveText("Fall 2026");
  await page.getByRole("button", { name: "Edit Fall 2026" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Unsaved staff edit");
  await db
    .doc(`organizations/${orgId}/members/browser-staff`)
    .update({ status: "revoked" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("Access unavailable");
  await expect(page.getByText("Fall 2026")).toHaveCount(0);
});
