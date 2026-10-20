import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
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
const orgId = "browser-pilot";
const owner = "browser-pilot-owner";
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
  await page.getByLabel("Password", { exact: true }).fill("SyntheticPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
test.beforeAll(async () => {
  app = initializeApp({ projectId: "demo-team-hangout" }, "pilot-browser");
  db = getFirestore(app);
  await getAuth(app).createUser({
    uid: owner,
    email: `${owner}@example.test`,
    password: "SyntheticPassword123!",
    emailVerified: true,
  });
  const meta = { schemaVersion: 2, revision: 1, status: "active", orgId, createdAt: Timestamp.now(), updatedAt: Timestamp.now() };
  await db.doc(`users/${owner}`).set({ uid: owner, appRole: "user" });
  await db.doc(`organizations/${orgId}`).set({
    ...meta,
    name: "Cedar Pilot",
    features: {
      organizationV2: true,
      adminWorkspace: true,
      households: true,
      scheduler: true,
      attendance: true,
      conversations: true,
      attachments: false,
    },
    policies: { youthChannels: "closed" },
  });
  await db.doc(`organizations/${orgId}/members/${owner}`).set({ ...meta, roles: ["orgAdmin"], programIds: [] });
  await db.doc(`organizations/${orgId}/scheduleOperations/stuck-pub`).set({
    ...meta,
    state: "staging",
    actorUid: "hidden-operator",
    updatedAt: Timestamp.fromMillis(Date.now() - 11 * 60 * 1000),
  });
  await db.doc(`organizations/${orgId}/attachments/secret-file`).set({
    ...meta,
    state: "rejected",
    rejectionCode: "SCAN_FAILED",
    ownerUid: "hidden-owner",
    fileName: "secret-photo.jpg",
  });
});
test.afterAll(async () => {
  await deleteApp(app);
});
test("an administrator sees stuck work and can stop writers without losing history", async ({ page }) => {
  await page.goto(`/organizations/${orgId}/pilot`);
  await login(page);
  await expect(page.getByRole("heading", { name: "Pilot operations" })).toBeVisible();
  await expect(page.getByText("attachments off")).toBeVisible();
  await expect(page.getByText("conversations on")).toBeVisible();
  await expect(page.getByRole("heading", { name: "stuck-pub" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "SCAN_FAILED" })).toBeVisible();
  await expect(page.getByText("secret-photo.jpg")).toHaveCount(0);
  await expect(page.getByText("hidden-owner")).toHaveCount(0);
  await expect(page.getByText("hidden-operator")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "SCAN_FAILED" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await capture(page, "pilot-operations");
  await page.getByRole("checkbox", { name: "I understand new phase 2 writes stop and history stays" }).check();
  await page.getByRole("button", { name: "Disable phase 2 writers" }).click();
  await expect(page.getByText("Phase 2 writers are off. History was kept. Quarantined publications: 1.")).toBeVisible();
  await expect(page.getByText("conversations off")).toBeVisible();
  await expect(page.getByText("organizationV2 on")).toBeVisible();
  await expect(page.getByText("No publication has been stuck for 10 minutes.")).toBeVisible();
  await db.doc(`organizations/${orgId}/members/${owner}`).update({ status: "revoked" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("SCAN_FAILED")).toHaveCount(0);
});
test("a refresh during rollback shows the disabled writers", async ({ page }) => {
  await db.doc(`organizations/${orgId}/members/${owner}`).update({ status: "active" });
  await db.doc(`organizations/${orgId}`).update({ "features.conversations": true });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let lists = 0;
  await page.route("**/listPilotOperations", async (route) => {
    lists += 1;
    await route.continue();
  });
  await page.route("**/applyPilotRollback", async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto(`/organizations/${orgId}/pilot`);
  await login(page);
  await expect(page.getByText("conversations on")).toBeVisible();
  const seen = lists;
  await page.getByRole("checkbox", { name: "I understand new phase 2 writes stop and history stays" }).check();
  const action = page.getByRole("button", { name: "Disable phase 2 writers" });
  await action.click();
  await expect(action).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => lists).toBeGreaterThan(seen);
  await expect(page.getByText("conversations on")).toBeVisible();
  release();
  await expect(page.getByText("Phase 2 writers are off. History was kept.")).toBeVisible();
  await expect(page.getByText("conversations off")).toBeVisible();
  const confirm = page.getByRole("checkbox", { name: "I understand new phase 2 writes stop and history stays" });
  await expect(confirm).not.toBeChecked();
  await confirm.check();
  await expect(action).toBeEnabled();
});
test("stuck publications say when the oldest page is incomplete", async ({ page }) => {
  await db.doc(`organizations/${orgId}/members/${owner}`).update({ status: "active" });
  const batch = db.batch();
  const now = Date.now();
  for (let index = 0; index < 26; index += 1) {
    const id = `aged-${String(index).padStart(2, "0")}`;
    batch.set(db.doc(`organizations/${orgId}/scheduleOperations/${id}`), {
      schemaVersion: 2,
      revision: 1,
      status: "active",
      orgId,
      state: "staging",
      updatedAt: Timestamp.fromMillis(now - (40 - index) * 60 * 1000),
      createdAt: Timestamp.now(),
    });
  }
  await batch.commit();
  await page.goto(`/organizations/${orgId}/pilot`);
  await login(page);
  await expect(page.getByText("More stuck publications exist than this list shows.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "aged-00" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "aged-25" })).toHaveCount(0);
});
