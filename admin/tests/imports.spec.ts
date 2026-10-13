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
  process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8080"
)
  throw new Error("Use isolated test:admin harness.");
test.describe.configure({ mode: "serial" });
let app: any, db: any;
const orgId = "browser-imports";
const uid = "browser-import-owner";
const head =
  "externalId,participantName,kind,teamExternalId,guardianEmail1,guardianEmail2";
async function capture(page: Page, name: string) {
  if (process.env.ADMIN_EVIDENCE_DIR) {
    await mkdir(process.env.ADMIN_EVIDENCE_DIR, { recursive: true });
    await page.evaluate(async () => {
      await document.fonts.ready;
      window.scrollTo(0, 0);
    });
    await page.screenshot({
      path: path.join(process.env.ADMIN_EVIDENCE_DIR, `${name}.png`),
      fullPage: true,
    });
  }
}
async function open(page: Page) {
  await page.goto(`/organizations/${orgId}/import`);
  await page.getByLabel("Email address").fill(`${uid}@example.test`);
  await page
    .getByLabel("Password", { exact: true })
    .fill("SyntheticPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Upload and map a CSV" }),
  ).toBeVisible();
}
async function upload(page: Page, body: string) {
  await page
    .getByRole("combobox", { name: "Program", exact: true })
    .selectOption("import-program");
  await page
    .getByRole("combobox", { name: "Target season", exact: true })
    .selectOption("import-season");
  await page.getByLabel("CSV file").setInputFiles({
    name: "roster.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`${head}\r\n${body}`),
  });
  await page.getByRole("button", { name: "Upload for server preview" }).click();
  await expect(page.getByText(/^preview · Previewed/)).toBeVisible({
    timeout: 45000,
  });
}
async function confirm(page: Page) {
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Confirm and commit roster" }).click();
  await expect(page.getByText(/^complete · Previewed/)).toBeVisible({
    timeout: 45000,
  });
}
test.beforeAll(async () => {
  app = initializeApp({ projectId: "demo-team-hangout" }, "import-browser");
  db = getFirestore(app);
  await getAuth(app).createUser({
    uid,
    email: `${uid}@example.test`,
    password: "SyntheticPassword123!",
  });
  await db.doc(`users/${uid}`).set({ uid, appRole: "user" });
  const meta = {
    schemaVersion: 2,
    revision: 1,
    orgId,
    status: "active",
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    createdBy: uid,
    updatedBy: uid,
  };
  await db.doc(`organizations/${orgId}`).set({
    ...meta,
    name: "Cedar Park Athletics",
    kind: "club",
    features: {
      adminWorkspace: true,
      organizationV2: true,
      imports: true,
      households: true,
    },
  });
  await db
    .doc(`organizations/${orgId}/members/${uid}`)
    .set({ ...meta, roles: ["orgAdmin"], programIds: [] });
  await db
    .doc(`organizations/${orgId}/programs/import-program`)
    .set({ ...meta, name: "Soccer", sportCode: "soccer" });
  await db.doc(`organizations/${orgId}/seasons/import-season`).set({
    ...meta,
    programId: "import-program",
    name: "Fall 2026",
    startsOn: "2026-09-01",
    endsOn: "2026-12-31",
  });
  await db.doc(`organizations/${orgId}/divisions/import-division`).set({
    ...meta,
    programId: "import-program",
    seasonId: "import-season",
    name: "U12",
  });
  await db.doc("teams/browser-import-team").set({
    ...meta,
    programId: "import-program",
    seasonId: "import-season",
    divisionId: "import-division",
    name: "Falcons",
    externalId: "U12",
  });
  await db.doc(`organizations/${orgId}/participants/browser-old-identity`).set({
    ...meta,
    displayName: "Jamie Example",
    kind: "youth",
    linkedUserId: null,
  });
});
test.afterAll(async () => deleteApp(app));
test("roster preview resolves duplicates and ambiguous names, commits once and downloads sanitized outcomes", async ({
  page,
}) => {
  await open(page);
  await capture(page, "01-import-empty");
  await page.getByLabel("CSV file").setInputFiles({
    name: "invalid.csv",
    mimeType: "text/csv",
    buffer: Buffer.from([0xff]),
  });
  await expect(page.getByRole("alert")).toContainText("UTF-8");
  await capture(page, "02-import-invalid-encoding");
  await upload(
    page,
    ',Jamie Example,youth,U12,parent@example.test,\r\nduplicate,Dup,youth,U12,,\r\nduplicate,Dup,youth,U12,,\r\nstable,"Casey\nExample",youth,U12,,',
  );
  await expect(
    page.getByText("Needs resolution 3", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm and commit roster" }),
  ).toBeDisabled();
  await capture(page, "03-import-review");
  await page
    .getByRole("button", { name: "Create separate participant for row 1" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Row resolution accepted." }),
  ).toBeVisible();
  for (const n of [2, 3]) {
    await page
      .getByRole("button", { name: `Skip row ${n}`, exact: true })
      .click();
    await expect(
      page.getByText(new RegExp(`Needs resolution ${3 - n}`)),
    ).toBeVisible();
  }
  await page.getByRole("checkbox").check();
  await capture(page, "04-import-confirmation");
  await page.getByRole("button", { name: "Confirm and commit roster" }).click();
  await expect(page.getByText(/^complete · Previewed/)).toBeVisible({
    timeout: 45000,
  });
  await expect(
    page.getByText(/Created 2 · Updated 0 · Skipped 2/),
  ).toBeVisible();
  await capture(page, "05-import-complete");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download outcome CSV" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("roster-import-outcome-v1.csv");
  await page
    .getByRole("button", {
      name: "Review guardian invitation for row 1 to parent@example.test",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "Queue confirmed guardian invitation" }),
  ).toBeDisabled();
  await expect(
    page
      .getByText("Acting account:", { exact: false })
      .filter({ hasText: "Recipient: parent@example.test" }),
  ).toBeVisible();
  await page.getByRole("checkbox").check();
  await capture(page, "09-import-invitation-confirmation");
  await page
    .getByRole("button", { name: "Queue confirmed guardian invitation" })
    .click();
  await expect(
    page.getByText("Guardian invitation queue accepted.", { exact: true }),
  ).toBeVisible();
  expect(
    (await db.collection(`organizations/${orgId}/invitations`).get()).size,
  ).toBe(1);
  await page
    .getByRole("button", {
      name: "Review guardian invitation for row 1 to parent@example.test",
      exact: true,
    })
    .click();
  await page.getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Queue confirmed guardian invitation" })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Confirm guardian invitation",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(
    (await db.collection(`organizations/${orgId}/invitations`).get()).size,
  ).toBe(1);
  const jobId = await page.getByLabel("Import job ID").inputValue();
  await page.reload();
  await expect(page.getByLabel("Import job ID")).toBeVisible();
  await page.getByLabel("Import job ID").fill(jobId);
  await page.getByRole("button", { name: "Open saved import" }).click();
  await expect(page.getByText(/^complete · Previewed/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: "Roster CSV imports", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(page, "06-import-mobile");
});
test("focus preserves file mapping, uncertain upload retries same request, and revoked reads clear job data", async ({
  page,
}) => {
  await open(page);
  await page
    .getByRole("combobox", { name: "Program", exact: true })
    .selectOption("import-program");
  await page
    .getByRole("combobox", { name: "Target season", exact: true })
    .selectOption("import-season");
  await page.getByLabel("CSV file").setInputFiles({
    name: "retry.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`${head}\nretry-browser,Riley Retry,youth,U12,,`),
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText("Local parse: 1 rows.", { exact: false }),
  ).toBeVisible();
  let interrupted = false;
  const payloads: string[] = [];
  await page.route("**/uploadRosterImport", async (route) => {
    payloads.push(route.request().postData() || "");
    const response = await route.fetch();
    if (!interrupted) {
      interrupted = true;
      await route.abort("failed");
    } else await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Upload for server preview" }).click();
  await expect(
    page.getByRole("button", { name: "Retry upload with the same request" }),
  ).toBeVisible({ timeout: 45000 });
  await capture(page, "07-import-retained-retry");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page
    .getByRole("button", { name: "Retry upload with the same request" })
    .click();
  await expect(page.getByText(/^preview · Previewed/)).toBeVisible({
    timeout: 45000,
  });
  expect(payloads.length).toBe(2);
  expect(payloads[0]).toBe(payloads[1]);
  await confirm(page);
  await db
    .doc(`organizations/${orgId}/members/${uid}`)
    .update({ status: "revoked" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("Access unavailable");
  await expect(page.getByText("Riley Retry", { exact: true })).toHaveCount(0);
  await capture(page, "08-import-access-removed");
  await db
    .doc(`organizations/${orgId}/members/${uid}`)
    .update({ status: "active" });
});
