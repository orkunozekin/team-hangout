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
const orgId = "browser-attachments";
const owner = "browser-attachments-owner";
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("JFIF"), Buffer.from([0xff, 0xd9])]);
async function capture(page: Page, name: string) {
  if (!process.env.ADMIN_EVIDENCE_DIR) return;
  await mkdir(process.env.ADMIN_EVIDENCE_DIR, { recursive: true });
  await page.evaluate(async () => { await document.fonts.ready; window.scrollTo(0, 0); });
  await page.screenshot({ path: path.join(process.env.ADMIN_EVIDENCE_DIR, `${name}.png`), fullPage: true });
}
test.beforeAll(async () => {
  app = initializeApp({ projectId: "demo-team-hangout" }, "attachments-browser");
  const db = getFirestore(app);
  await getAuth(app).createUser({ uid: owner, email: `${owner}@example.test`, password: "SyntheticPassword123!", emailVerified: true });
  const meta = { schemaVersion: 2, revision: 1, status: "active", orgId, createdAt: Timestamp.now(), updatedAt: Timestamp.now() };
  await db.doc(`users/${owner}`).set({ uid: owner, appRole: "user" });
  await db.doc(`organizations/${orgId}`).set({ ...meta, name: "Cedar Attachments", features: { organizationV2: true, adminWorkspace: true, households: true, conversations: true, attachments: true }, policies: {} });
  await db.doc(`organizations/${orgId}/programs/soccer`).set({ ...meta, name: "Soccer" });
  await db.doc(`organizations/${orgId}/members/${owner}`).set({ ...meta, roles: ["orgAdmin"], programIds: [] });
  await db.doc("teams/browser-file-team").set({ ...meta, programId: "soccer", seasonId: "fall", divisionId: "u10", name: "Falcons" });
});
test.afterAll(async () => { if (app) await deleteApp(app); });
test("staff can upload a JPEG and download the same bytes", async ({ page }) => {
  await page.goto(`/organizations/${orgId}/conversations`);
  await page.getByLabel("Email address").fill(`${owner}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill("SyntheticPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Scope id").fill("browser-file-team");
  await page.getByRole("button", { name: "Open channel" }).click();
  await expect(page.getByLabel("Attachment file")).toBeVisible();
  await page.getByLabel("Attachment file").setInputFiles({ name: "photo.jpg", mimeType: "text/plain", buffer: jpeg });
  await page.getByRole("button", { name: "Upload attachment" }).click();
  await expect(page.getByText(/Ready · photo\.jpg · image\/jpeg · \d+ bytes\. Download matched the uploaded file\./)).toBeVisible();
  await expect(page.getByRole("region", { name: "Household channel" })).not.toContainText("JFIF");
  await expect(page.getByRole("region", { name: "Staff notes" })).not.toContainText("JFIF");
  await capture(page, "attachment-ready");
});
