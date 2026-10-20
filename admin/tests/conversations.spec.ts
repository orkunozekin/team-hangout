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
  await db.doc("teams/browser-search-team").set({ ...meta, programId: "soccer", seasonId: "fall", divisionId: "u10", name: "Owls" });
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
test("older household messages and staff notes stay reachable", async ({ page }) => {
  const { fingerprint } = require("./lib/operations/requests.js");
  const conversationId = fingerprint({ kind: "conversation", orgId, scopeType: "team", scopeId: "browser-talk-team", channel: "household" });
  const db = getFirestore(app);
  const batch = db.batch();
  for (let i = 1; i <= 26; i += 1) {
    batch.set(db.doc(`organizations/${orgId}/conversations/${conversationId}/messages/page-${String(i).padStart(2, "0")}`), {
      schemaVersion: 2, orgId, authorUid: owner, sequence: 100 + i, body: `Paged announcement ${i}`, tombstoned: false,
      createdAt: Timestamp.fromMillis(Date.parse("2026-10-01T00:00:00Z") + i * 1000),
    });
    batch.set(db.doc(`organizations/${orgId}/staffNotes/team_browser-talk-team/entries/note-${String(i).padStart(2, "0")}`), {
      schemaVersion: 2, orgId, scopeType: "team", scopeId: "browser-talk-team", authorUid: owner, body: `Paged note ${i}`,
      createdAt: Timestamp.fromMillis(Date.parse("2026-10-01T00:00:00Z") + i * 1000),
    });
  }
  await batch.commit();
  await page.goto(`/organizations/${orgId}/conversations`);
  await page.getByLabel("Email address").fill(`${owner}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill("SyntheticPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Scope id").fill("browser-talk-team");
  await page.getByRole("button", { name: "Open channel" }).click();
  const channel = page.getByRole("region", { name: "Household channel" });
  const notes = page.getByRole("region", { name: "Staff notes" });
  await expect(channel.getByText("Paged announcement 26", { exact: true })).toBeVisible();
  await expect(channel.getByText("Paged announcement 1", { exact: true })).toHaveCount(0);
  await expect(notes.getByText("Paged note 1", { exact: true })).toHaveCount(0);
  await channel.getByRole("button", { name: "Load older messages" }).click();
  await expect(channel.getByText("Paged announcement 1", { exact: true })).toBeVisible();
  await expect(channel.getByText("Paged announcement 26", { exact: true })).toBeVisible();
  await notes.getByRole("button", { name: "Load older notes" }).click();
  await expect(notes.getByText("Paged note 1", { exact: true })).toBeVisible();
  await expect(notes.getByText("Paged note 26", { exact: true })).toBeVisible();
});
test("staff can edit, remove, react, and search without finding a staff note", async ({ page }) => {
  await page.goto(`/organizations/${orgId}/conversations`);
  await page.getByLabel("Email address").fill(`${owner}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill("SyntheticPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Scope id").fill("browser-search-team");
  await page.getByRole("button", { name: "Open channel" }).click();
  const channel = page.getByRole("region", { name: "Household channel" });
  await page.getByRole("textbox", { name: "Announcement" }).fill("Practice is at the north field");
  await page.getByRole("button", { name: "Post announcement" }).click();
  const original = channel.getByRole("listitem").filter({ hasText: "Practice is at the north field" });
  await original.getByRole("button", { name: "Edit message" }).click();
  await original.getByRole("textbox", { name: "Replacement text" }).fill("Practice moved to the south field");
  await original.getByRole("button", { name: "Save edit" }).click();
  await expect(channel.getByText("Practice moved to the south field")).toBeVisible();
  await expect(channel.getByText("Edited")).toBeVisible();
  await expect(channel.getByText("Practice is at the north field")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Announcement" }).fill("Bring orange slices");
  await page.getByRole("button", { name: "Post announcement" }).click();
  const orange = channel.getByRole("listitem").filter({ hasText: "Bring orange slices" });
  await orange.getByRole("button", { name: "Remove message" }).click();
  await orange.getByRole("textbox", { name: "Removal reason" }).fill("Duplicate");
  await orange.getByRole("button", { name: "Confirm removal" }).click();
  await expect(channel.getByText("Message removed by a moderator")).toBeVisible();
  await expect(channel.getByText("Bring orange slices")).toHaveCount(0);
  const edited = channel.getByRole("listitem").filter({ hasText: "Practice moved to the south field" });
  await edited.getByRole("button", { name: "React with 👍 0" }).click();
  await expect(edited.getByRole("button", { name: "React with 👍 1" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("textbox", { name: "Staff note" }).fill("Guardian phone is private");
  await page.getByRole("button", { name: "Save staff note" }).click();
  await page.getByRole("textbox", { name: "Search words" }).fill("south");
  await page.getByRole("button", { name: "Search messages" }).click();
  const results = page.getByRole("region", { name: "Search messages" });
  await expect(results.getByText("Practice moved to the south field")).toBeVisible();
  await expect(results.getByText("Guardian phone is private")).toHaveCount(0);
  await expect(results.getByText("Bring orange slices")).toHaveCount(0);
  await capture(page, "conversation-search-edits");
  await page.getByRole("textbox", { name: "Search words" }).fill("orange");
  await page.getByRole("button", { name: "Search messages" }).click();
  await expect(results.getByText("No matching messages.")).toBeVisible();
});
