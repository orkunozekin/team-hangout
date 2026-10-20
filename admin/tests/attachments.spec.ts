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
const exif = Buffer.concat([Buffer.from("Exif\0\0"), Buffer.from("GPS-SYNTHETIC")]);
const exifLength = Buffer.alloc(2);
exifLength.writeUInt16BE(exif.length + 2);
const jpeg = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe1]), exifLength, exif,
  Buffer.from("ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432ffc0000b080001000101011100ffc4001f0000010501010101010100000000000000000102030405060708090a0bffda000800010100003f007f00ffd9", "hex"),
]);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const html = Buffer.from("<!DOCTYPE html><p>SYNTHETIC-HTML</p>");
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
test("staff see scanning, rejected, and ready files and can send the ready ones", async ({ page }) => {
  await page.goto(`/organizations/${orgId}/conversations`);
  await page.getByLabel("Email address").fill(`${owner}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill("SyntheticPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Scope id").fill("browser-file-team");
  await page.getByRole("button", { name: "Open channel" }).click();
  await expect(page.getByLabel("Attachment file")).toBeVisible();
  await page.getByLabel("Attachment file").setInputFiles({ name: "photo.jpg", mimeType: "text/plain", buffer: jpeg });
  await page.getByRole("button", { name: "Upload attachment" }).click();
  await expect(page.getByText(/Ready · photo\.jpg · image\/jpeg · \d+ bytes/)).toBeVisible();
  await page.getByLabel("Attachment file").setInputFiles({ name: "photo.jpg", mimeType: "text/plain", buffer: html });
  await page.getByRole("button", { name: "Upload attachment" }).click();
  await expect(page.getByText("Rejected · photo.jpg · UNSAFE_CONTENT")).toBeVisible();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/finalizeAttachment", async (route) => {
    await gate;
    await route.continue();
  });
  await page.getByLabel("Attachment file").setInputFiles({ name: "diagram.png", mimeType: "image/png", buffer: png });
  await page.getByRole("button", { name: "Upload attachment" }).click();
  await expect(page.getByText("Scanning · diagram.png")).toBeVisible();
  await expect(page.getByRole("region", { name: "Household channel" })).not.toContainText("GPS-SYNTHETIC");
  await expect(page.getByRole("region", { name: "Staff notes" })).not.toContainText("GPS-SYNTHETIC");
  await capture(page, "attachment-states");
  release();
  await expect(page.getByText(/Ready · diagram\.png · image\/png · \d+ bytes/)).toBeVisible();
  await page.getByRole("textbox", { name: "Announcement" }).fill("Practice photo is attached");
  await page.getByRole("button", { name: "Post announcement" }).click();
  await expect(page.getByRole("region", { name: "Household channel" })).toContainText("Practice photo is attached");
  await expect(page.getByLabel("Attachment status")).not.toContainText("Ready ·");
  await expect(page.getByRole("region", { name: "Household channel" })).toContainText("photo.jpg · image/jpeg");
  await expect(page.getByRole("region", { name: "Household channel" })).toContainText("diagram.png · image/png");
  await expect(page.getByRole("region", { name: "Household channel" })).not.toContainText("GPS-SYNTHETIC");
  await expect(page.getByRole("region", { name: "Staff notes" })).not.toContainText("photo.jpg");
});
