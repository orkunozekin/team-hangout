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
  throw new Error("Use the isolated admin emulator harness.");
test.describe.configure({ mode: "serial" });
// Synthetic organization and invented resources only; no real third-party content or approvals.
let app: any, db: any;
const orgId = "browser-practice";
const editor = "browser-practice-editor";
const reviewer = "browser-practice-reviewer";
const programId = "youth-soccer";
async function capture(page: Page, name: string) {
  if (!process.env.ADMIN_EVIDENCE_DIR) return;
  await mkdir(process.env.ADMIN_EVIDENCE_DIR, { recursive: true });
  await page.evaluate(async () => {
    await document.fonts.ready;
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  await page.screenshot({ path: path.join(process.env.ADMIN_EVIDENCE_DIR, `${name}.png`), fullPage: true });
}
async function login(page: Page, uid: string) {
  await page.goto(`/organizations/${orgId}/practice?program=${programId}`);
  await page.getByLabel("Email address").fill(`${uid}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill("SyntheticPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Practice resources", exact: true })).toBeVisible();
}
const content = (title: string, ageMin: number, ageMax: number) => ({
  title, objectives: ["Synthetic first-touch objective"], ageMin, ageMax, durationMinutes: 15, equipment: ["Cones", "Size 4 balls"],
  instructions: "Synthetic original instructions written for this test.", safetyNotes: "Synthetic reminder to keep two meters of spacing.",
});
const rights = { origin: "original", owner: "Cedar Youth League", allowedUses: "Coaching within the league", attribution: null,
  evidence: "Synthetic authorship record SYN-42", licenseUrl: null, expiresAt: null, derivativesAllowed: true };

test.beforeAll(async () => {
  app = initializeApp({ projectId: "demo-team-hangout" }, "practice-browser");
  db = getFirestore(app);
  const meta = { schemaVersion: 2, revision: 1, status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now() };
  for (const uid of [editor, reviewer]) {
    await getAuth(app).createUser({ uid, email: `${uid}@example.test`, password: "SyntheticPassword123!", emailVerified: true });
    await db.doc(`users/${uid}`).set({ uid, appRole: "user" });
    await db.doc(`organizations/${orgId}/members/${uid}`).set({ ...meta, orgId, roles: ["programStaff"], programIds: [programId] });
  }
  await db.doc(`organizations/${orgId}`).set({
    ...meta, orgId, name: "Cedar Youth League", kind: "club", timeZone: "America/Chicago",
    features: { organizationV2: true, adminWorkspace: true, practiceResources: true },
  });
  await db.doc(`organizations/${orgId}/programs/${programId}`).set({ ...meta, orgId, name: "Youth Soccer", sportCode: "soccer", sportLabel: null });
  await db.doc(`organizations/${orgId}/resourceReviewers/${reviewer}`).set({
    ...meta, orgId, userId: reviewer, programIds: [programId], qualification: "Synthetic safeguarding review",
  });
  const now = Timestamp.now();
  const review = { reviewerUid: reviewer, qualification: "Synthetic safeguarding review", rightsVerified: true, ageSafetyReviewed: true, note: null, reviewedAt: now };
  const resource = (id: string, title: string, ageMin: number, ageMax: number, published: boolean) => db.doc(`organizations/${orgId}/practiceResources/${id}`).set({
    schemaVersion: 2, orgId, programId, sportCode: "soccer", status: published ? "published" : "draft", title, revision: 1,
    ages: published ? Array.from({ length: ageMax - ageMin + 1 }, (_, i) => ageMin + i) : [],
    draft: published ? null : { version: 1, content: content(title, ageMin, ageMax), rights, editedBy: editor, editedAt: now },
    published: published ? { version: 1, content: content(title, ageMin, ageMax), rights, editedBy: editor, review, publishedAt: now } : null,
    createdAt: now, createdBy: editor, updatedAt: now, updatedBy: editor,
  });
  await resource("a-rondo", "Four-corner rondo", 9, 12, true);
  await resource("b-gates", "Passing gates", 6, 8, false);
  await resource("c-tag", "Dribble tag", 6, 9, true);
});
test.afterAll(async () => {
  await deleteApp(app);
});

test("an editor saves a draft that stays unpublished until another reviewer approves it", async ({ page }) => {
  await login(page, editor);
  await page.getByRole("button", { name: "New resource" }).click();
  const form = page.getByRole("region", { name: "New resource" });
  await form.getByLabel("Title", { exact: true }).fill("Shield the ball");
  await form.getByLabel("Objectives, one per line").fill("Synthetic shielding objective");
  await form.getByLabel("Youngest age").fill("8");
  await form.getByLabel("Oldest age").fill("10");
  await form.getByLabel("Duration in minutes").fill("12");
  await form.getByLabel("Instructions", { exact: true }).fill("Synthetic original steps.");
  await form.getByLabel("Safety instructions").fill("Synthetic spacing reminder.");
  await form.getByLabel("Rights owner").fill("Cedar Youth League");
  await form.getByLabel("Allowed uses").fill("Coaching within the league");
  await form.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("alert")).toContainText("Record the rights evidence reference before saving.");
  await form.getByLabel("Rights evidence reference").fill("Synthetic authorship record SYN-43");
  await form.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved draft of Shield the ball" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "awaits a designated reviewer who did not edit it" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and publish" })).toHaveCount(0);
});

test("a designated reviewer filters by age, approves a draft and withdraws a resource", async ({ page }) => {
  await login(page, reviewer);
  await page.getByLabel("Player age").fill("15");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("No published resources for age 15.")).toBeVisible();
  await page.getByLabel("Player age").fill("7");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("row", { name: /Dribble tag/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Four-corner rondo/ })).toHaveCount(0);
  await page.getByLabel("Player age").fill("");
  await page.getByLabel("Status").selectOption("");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.getByRole("button", { name: "Open Passing gates" }).click();
  const detail = page.getByRole("region", { name: /Passing gates/ });
  const approve = detail.getByRole("button", { name: "Approve and publish" });
  await expect(approve).toBeDisabled();
  await detail.getByLabel("I verified the rights evidence and allowed uses").check();
  await detail.getByLabel("I reviewed sport, age band, equipment, duration and safety instructions").check();
  await approve.click();
  await expect(page.getByRole("status").filter({ hasText: "Approved and published" })).toBeVisible();
  await expect(page.getByRole("row", { name: /Passing gates/ })).toContainText("Published v1");
  const stored = (await db.doc(`organizations/${orgId}/practiceResources/b-gates`).get()).data();
  expect(stored.published.review.reviewerUid).toBe(reviewer);
  expect(stored.ages).toEqual([6, 7, 8]);

  await page.getByRole("button", { name: "Open Dribble tag" }).click();
  const tag = page.getByRole("region", { name: /Dribble tag/ });
  await tag.getByLabel("Withdrawal reason").fill("Synthetic permission ended");
  await tag.getByRole("button", { name: "Withdraw resource" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Withdrawn. Coaches can no longer add it." })).toBeVisible();
  await expect(page.getByRole("row", { name: /Dribble tag/ })).toContainText("Withdrawn");
  await page.getByRole("button", { name: "Open Passing gates" }).click();
  await expect(page.getByRole("region", { name: /Passing gates: Published/ })).toBeVisible();
  await capture(page, "practice-resources");
});
