import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const require = createRequire(new URL("../../functions/package.json", import.meta.url));
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
if (process.env.ADMIN_EMULATOR_TESTS !== "1" || process.env.GCLOUD_PROJECT !== "demo-team-hangout" || process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8080")
  throw new Error("Use isolated test:admin harness.");
test.describe.configure({ mode: "serial" });
let app: any;
const orgId = "browser-conversations", owner = "browser-conversations-owner";
async function capture(page: Page, name: string) {
  if (!process.env.ADMIN_EVIDENCE_DIR) return;
  await mkdir(process.env.ADMIN_EVIDENCE_DIR, { recursive: true });
  await page.evaluate(async () => { await document.fonts.ready; window.scrollTo(0, 0); });
  await page.screenshot({ path: path.join(process.env.ADMIN_EVIDENCE_DIR, `${name}.png`), fullPage: true });
}
test.beforeAll(async () => {
  app = initializeApp({ projectId: "demo-team-hangout" }, "conversations-browser");
  const db = getFirestore(app);
  await getAuth(app).createUser({ uid: owner, email: `${owner}@example.test`, password: "SyntheticPassword123!", emailVerified: true });
  const meta = { schemaVersion: 2, revision: 1, status: "active", orgId, createdAt: Timestamp.now(), updatedAt: Timestamp.now() };
  await db.doc(`users/${owner}`).set({ uid: owner, appRole: "user" });
  await db.doc(`organizations/${orgId}`).set({ ...meta, name: "Cedar Conversations", features: { organizationV2: true, adminWorkspace: true, households: true, conversations: true }, policies: {} });
  await db.doc(`organizations/${orgId}/programs/soccer`).set({ ...meta, name: "Soccer" });
  await db.doc(`organizations/${orgId}/members/${owner}`).set({ ...meta, roles: ["orgAdmin"], programIds: [] });
  await db.doc("teams/browser-talk-team").set({ ...meta, programId: "soccer", seasonId: "fall", divisionId: "u10", name: "Falcons" });
});
test.afterAll(async () => { if (app) await deleteApp(app); });
test("staff can post a household announcement and a separate staff note", async ({ page }) => {
  await page.goto(`/organizations/${orgId}/conversations`);
  await page.getByLabel("Email address").fill(`${owner}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill("SyntheticPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Scope id").fill("browser-talk-team");
  await page.getByRole("button", { name: "Open channel" }).click();
  await expect(page.getByText("Youth posting is closed until an administrator approves the organization policy.")).toBeVisible();
  await page.getByRole("textbox", { name: "Announcement" }).fill("Practice is at the north field");
  await page.getByRole("button", { name: "Post announcement" }).click();
  await expect(page.getByRole("region", { name: "Household channel" }).getByText("Practice is at the north field")).toBeVisible();
  await page.getByRole("textbox", { name: "Staff note" }).fill("Guardian phone is private");
  await page.getByRole("button", { name: "Save staff note" }).click();
  const notes = page.getByRole("region", { name: "Staff notes" });
  await expect(notes.getByText("Guardian phone is private")).toBeVisible();
  await expect(page.getByRole("region", { name: "Household channel" }).getByText("Guardian phone is private")).toHaveCount(0);
  await capture(page, "conversations-and-staff-notes");
});
