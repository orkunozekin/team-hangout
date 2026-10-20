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
const orgId = "browser-diagnostics",
  owner = "browser-diagnostics-owner";
async function capture(page: Page, name: string) {
  if (!process.env.ADMIN_EVIDENCE_DIR) return;
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
async function login(page: Page) {
  await page.getByLabel("Email address").fill(`${owner}@example.test`);
  await page
    .getByLabel("Password", { exact: true })
    .fill("SyntheticPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
test.beforeAll(async () => {
  app = initializeApp({ projectId: "demo-team-hangout" }, "diagnostics-browser");
  db = getFirestore(app);
  await getAuth(app).createUser({
    uid: owner,
    email: `${owner}@example.test`,
    password: "SyntheticPassword123!",
    emailVerified: true,
  });
  const meta = {
    schemaVersion: 2,
    revision: 1,
    status: "active",
    orgId,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  };
  await db.doc(`users/${owner}`).set({ uid: owner, appRole: "user" });
  await db.doc(`organizations/${orgId}`).set({
    ...meta,
    name: "Cedar Diagnostics",
    features: { organizationV2: true, adminWorkspace: true, households: true },
  });
  await db
    .doc(`organizations/${orgId}/members/${owner}`)
    .set({ ...meta, roles: ["orgAdmin"], programIds: [] });
  await db.doc(`organizations/${orgId}/deliveryIssues/bounce`).set({
    ...meta,
    channel: "email",
    status: "permanentFailure",
    failureCode: "EMAIL_BOUNCED",
    templateKey: "rsvpReminder",
    programId: "soccer",
    recipientUid: "hidden-person",
    recipientEmail: "secret@example.test",
    expoPushToken: "ExponentPushToken[secret]",
    updatedAt: Timestamp.fromDate(new Date("2026-10-20T15:00:00.000Z")),
  });
  await db.doc(`organizations/${orgId}/deliveryIssues/expired`).set({
    ...meta,
    channel: "push",
    status: "permanentFailure",
    failureCode: "DeviceNotRegistered",
    templateKey: "rsvpReminder",
    programId: "soccer",
    recipientUid: "hidden-person",
    updatedAt: Timestamp.fromDate(new Date("2026-10-20T14:00:00.000Z")),
  });
  await db.doc(`organizations/${orgId}/criticalUpdates/closure`).set({
    ...meta,
    title: "Facility closed",
    templateKey: "facilityClosure",
    sourceRevision: 4,
    programId: "soccer",
    recipientUid: "hidden-person",
    acknowledgedAt: null,
    createdAt: Timestamp.fromDate(new Date("2026-10-20T13:00:00.000Z")),
  });
});
test.afterAll(async () => {
  await deleteApp(app);
});
test("staff see delivery failure and missing acknowledgement as separate facts", async ({
  page,
}) => {
  await page.goto(`/organizations/${orgId}/diagnostics`);
  await login(page);
  await expect(
    page.getByRole("heading", { name: "Delivery failures" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "EMAIL_BOUNCED" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "DeviceNotRegistered" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Unacknowledged critical updates" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Facility closed" })).toBeVisible();
  await expect(page.getByText("Not acknowledged", { exact: true })).toBeVisible();
  await expect(page.getByText("secret@example.test")).toHaveCount(0);
  await expect(page.getByText(/ExponentPushToken/)).toHaveCount(0);
  await expect(page.getByText("hidden-person")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await capture(page, "diagnostics-failure-and-unacknowledged");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Facility closed" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await db.doc(`organizations/${orgId}/members/${owner}`).update({ status: "revoked" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByText("EMAIL_BOUNCED")).toHaveCount(0);
  await expect(page.getByText("Not acknowledged", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toBeVisible();
});
test("older delivery failures stay reachable", async ({ page }) => {
  await db.doc(`organizations/${orgId}/members/${owner}`).update({ status: "active" });
  for (let index = 0; index < 26; index += 1) {
    await db.doc(`organizations/${orgId}/deliveryIssues/page-${index}`).set({
      schemaVersion: 2,
      revision: 1,
      status: "permanentFailure",
      orgId,
      channel: "email",
      failureCode: index === 0 ? "OLDEST_FAILURE" : "PAGE_FAILURE",
      templateKey: "rsvpReminder",
      programId: "soccer",
      updatedAt: Timestamp.fromMillis(Date.parse("2026-10-01T00:00:00.000Z") + index * 60000),
      createdAt: Timestamp.fromMillis(Date.parse("2026-10-01T00:00:00.000Z")),
    });
  }
  await page.goto(`/organizations/${orgId}/diagnostics`);
  await login(page);
  await expect(page.getByRole("heading", { name: "EMAIL_BOUNCED" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "OLDEST_FAILURE" })).toHaveCount(0);
  await page.getByRole("button", { name: "Show more delivery failures" }).click();
  await expect(page.getByRole("heading", { name: "OLDEST_FAILURE" })).toBeVisible();
  await expect(page.getByText("secret@example.test")).toHaveCount(0);
});
