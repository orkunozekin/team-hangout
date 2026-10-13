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
)
  throw new Error("Use isolated test:admin harness.");
test.describe.configure({ mode: "serial" });
let app: any;
const uid = "a11y-owner",
  orgId = "a11y-club";
async function capture(page: Page, name: string) {
  if (!process.env.ADMIN_EVIDENCE_DIR) return;
  await mkdir(process.env.ADMIN_EVIDENCE_DIR, { recursive: true });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.screenshot({
    path: path.join(process.env.ADMIN_EVIDENCE_DIR, `${name}.png`),
    fullPage: true,
  });
}
test.beforeAll(async () => {
  app = initializeApp(
    { projectId: "demo-team-hangout" },
    "accessibility-browser",
  );
  const db = getFirestore(app),
    meta = {
      schemaVersion: 2,
      status: "active",
      revision: 1,
      orgId,
      createdBy: uid,
      updatedBy: uid,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    };
  try {
    await getAuth(app).createUser({
      uid,
      email: `${uid}@example.test`,
      password: "SyntheticPassword123!",
      emailVerified: true,
    });
  } catch (error: any) {
    if (error.code !== "auth/uid-already-exists") throw error;
  }
  const rows: [string, object][] = [
    [`users/${uid}`, { uid, appRole: "user" }],
    [`users/${uid}/organizationLinks/${orgId}`, { orgId, status: "active" }],
    [
      `organizations/${orgId}`,
      {
        ...meta,
        name: "Synthetic Community Athletics",
        kind: "communityCenter",
        timeZone: "America/Chicago",
        features: {
          organizationV2: true,
          adminWorkspace: true,
          households: true,
          imports: true,
          calendarSubscriptions: true,
          essentialEmail: true,
        },
      },
    ],
    [
      `organizations/${orgId}/members/${uid}`,
      { ...meta, roles: ["orgAdmin"], programIds: [] },
    ],
    [
      `organizations/${orgId}/programs/soccer`,
      { ...meta, name: "Youth soccer", sportCode: "soccer", sportLabel: null },
    ],
    [
      `organizations/${orgId}/seasons/fall`,
      {
        ...meta,
        programId: "soccer",
        name: "Fall season",
        startsOn: "2026-09-01",
        endsOn: "2026-12-31",
      },
    ],
    [
      `organizations/${orgId}/divisions/u12`,
      { ...meta, programId: "soccer", seasonId: "fall", name: "Under 12" },
    ],
    [
      "teams/a11y-team",
      {
        ...meta,
        programId: "soccer",
        seasonId: "fall",
        divisionId: "u12",
        name: "Synthetic very long team name for text wrapping",
        externalId: "U12",
      },
    ],
  ];
  const batch = db.batch();
  for (const [key, value] of rows) batch.set(db.doc(key), value);
  await batch.commit();
});
test.afterAll(async () => deleteApp(app));
async function login(page: Page) {
  await page.goto(`/organizations/${orgId}/program`);
  await page.getByLabel("Email address").fill(`${uid}@example.test`);
  await page
    .getByLabel("Password", { exact: true })
    .fill("SyntheticPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Programs", exact: true }),
  ).toBeVisible();
}
test("keyboard skip, visible focus, labelled editor, errors and table actions", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to main content" }),
  ).toBeFocused();
  await expect(
    page.getByRole("link", { name: "Skip to main content" }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await login(page);
  const action = page.getByRole("button", { name: "New program", exact: true });
  await action.focus();
  await page.keyboard.press("Enter");
  await page.getByLabel("Name", { exact: true }).fill("");
  await page.getByRole("button", { name: "Save changes", exact: true }).focus();
  await page.keyboard.press("Enter");
  // Native required validation is also keyboard accessible and retains the labelled field.
  await expect(page.getByLabel("Name", { exact: true })).toBeFocused();
  await page.getByLabel("Name", { exact: true }).fill("Keyboard program");
  await page.getByRole("button", { name: "Save changes", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.locator("td strong").filter({ hasText: "Keyboard program" }),
  ).toBeVisible();
  const region = page.getByRole("region", { name: "Records table" });
  await region.focus();
  await expect(region).toBeFocused();
  await expect(
    page.getByRole("columnheader", { name: "Name", exact: true }),
  ).toHaveAttribute("scope", "col");
  const edit = page.getByRole("button", { name: "Edit Keyboard program" });
  expect((await edit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await capture(page, "a11y-keyboard-table");
});
test("introduced browser screens reflow at 200 percent and preserve phone action targets", async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 780, height: 1200 });
  const screens = [
    "program",
    "season",
    "division",
    "team",
    "staff",
    "organization",
    "participant",
    "invitation",
    "import",
    "schedule",
  ];
  for (const section of screens) {
    await page.goto(`/organizations/${orgId}/${section}`);
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: /Loading|Authorizing/ })).toHaveCount(0);
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1,
    );
    expect(overflow, section).toBe(false);
    for (const button of await page.locator("main button:visible").all())
      expect(
        (await button.boundingBox())!.height,
        section,
      ).toBeGreaterThanOrEqual(44);
    if (["team", "import", "invitation"].includes(section))
      await capture(page, `a11y-large-${section}`);
  }
  for (const url of [
    "/calendar-subscriptions",
    "/email-preferences",
    "/help",
    "/invitation",
    "/events/missing-synthetic-event",
  ]) {
    await page.goto(url);
    await expect(page.getByRole("main")).toBeVisible();
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth + 1,
      ),
      url,
    ).toBe(false);
  }
  await expect(page.getByRole("alert")).toBeVisible();
  await capture(page, "a11y-large-private-error");
});
