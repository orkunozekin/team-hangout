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
let app: any, db: any;
const orgId = "browser-rollover";
const owner = "browser-rollover-owner";
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
async function login(page: Page) {
  await page.getByLabel("Email address").fill(`${owner}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill("SyntheticPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
async function choose(page: Page, name: string) {
  await page.getByLabel("Program").selectOption(programId);
  await page.getByLabel("Source season").selectOption("fall");
  await page.getByLabel("New season name").fill(name);
  await page.getByLabel("Starts").fill("2027-03-01");
  await page.getByLabel("Ends").fill("2027-06-30");
  await page.getByRole("button", { name: "Preview rollover" }).click();
}
test.beforeAll(async () => {
  app = initializeApp({ projectId: "demo-team-hangout" }, "rollover-browser");
  db = getFirestore(app);
  await getAuth(app).createUser({ uid: owner, email: `${owner}@example.test`, password: "SyntheticPassword123!", emailVerified: true });
  const meta = { schemaVersion: 2, revision: 1, status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now() };
  await db.doc(`users/${owner}`).set({ uid: owner, appRole: "user" });
  await db.doc(`organizations/${orgId}`).set({
    ...meta, orgId, name: "Cedar Youth League", kind: "club", timeZone: "America/Chicago",
    features: { organizationV2: true, adminWorkspace: true, rollover: true },
  });
  await db.doc(`organizations/${orgId}/members/${owner}`).set({ ...meta, orgId, roles: ["orgAdmin"], programIds: [] });
  await db.doc(`organizations/${orgId}/programs/${programId}`).set({ ...meta, orgId, name: "Youth Soccer", sportCode: "soccer", sportLabel: null });
  await db.doc(`organizations/${orgId}/seasons/fall`).set({ ...meta, status: "archived", orgId, programId, name: "Fall 2026", startsOn: "2026-09-01", endsOn: "2026-11-30" });
  await db.doc(`organizations/${orgId}/divisions/u10`).set({ ...meta, orgId, programId, seasonId: "fall", name: "U10", ageBandLabel: null });
  await db.doc(`organizations/${orgId}/divisions/u12`).set({ ...meta, orgId, programId, seasonId: "fall", name: "U12", ageBandLabel: null });
  const teams: [string, string, string, string][] = [
    ["hawks", "Hawks", "u10", "active"], ["owls", "Owls", "u10", "active"], ["foxes", "Foxes", "u12", "active"],
    ["herons", "Herons", "u12", "active"], ["wolves", "Wolves", "u12", "archived"],
  ];
  for (const [id, name, divisionId, status] of teams) {
    await db.doc(`teams/${id}`).set({ ...meta, status, orgId, programId, seasonId: "fall", divisionId, name, sport: "soccer", inviteCode: null });
  }
  await db.doc(`teamMembers/hawks_${owner}`).set({ ...meta, orgId, teamId: "hawks", userId: owner, roles: ["coach"] });
  // Twenty newer completed jobs push the stopped one onto the second page of the list.
  for (let n = 0; n < 20; n++) {
    await db.doc(`organizations/${orgId}/rolloverJobs/done-${n}`).set({
      schemaVersion: 2, revision: 2, orgId, jobId: `done-${n}`, programId, sourceSeasonId: "fall", targetSeasonId: `old-${n}`, state: "complete",
      target: { name: `Archive ${n}`, startsOn: "2026-12-01", endsOn: "2027-02-28" }, previewHash: "1".repeat(64),
      counts: { divisions: 1, excludedDivisions: 0, teams: 1, excludedTeams: 0 }, created: { divisions: 1, teams: 1 }, chunkCount: 1, nextChunk: 1,
      attempts: 1, createdAt: Timestamp.fromDate(new Date(Date.UTC(2026, 9, 2 + n))), failure: null,
    });
  }
  // An earlier rollover that stopped after its first checkpoint when its administrator lost access.
  await db.doc(`organizations/${orgId}/rolloverJobs/stopped`).set({
    schemaVersion: 2, revision: 1, orgId, jobId: "stopped", programId, sourceSeasonId: "fall", targetSeasonId: "hidden", state: "failed",
    target: { name: "Winter 2026", startsOn: "2026-12-01", endsOn: "2027-02-28" }, previewHash: "0".repeat(64),
    counts: { divisions: 2, excludedDivisions: 0, teams: 201, excludedTeams: 0 }, created: { divisions: 2, teams: 98 }, chunkCount: 3, nextChunk: 1,
    attempts: 1, createdAt: Timestamp.fromDate(new Date("2026-10-01T12:00:00Z")),
    failure: { code: "ROLLOVER_ACCESS_REVOKED", message: "The administrator who started this rollover no longer has access. Another administrator can resume it." },
  });
});
test.afterAll(async () => {
  await deleteApp(app);
});

test("an administrator previews exclusions, sees a changed source rejected and commits a draft season", async ({ page }) => {
  await page.goto(`/organizations/${orgId}/rollover`);
  await login(page);
  await expect(page.getByRole("heading", { name: "Season rollover", exact: true })).toBeVisible();
  await expect(page.getByText("Winter 2026")).toBeVisible();
  await expect(page.getByText("100 of 203 records created, step 1 of 3")).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume from checkpoint" })).toBeVisible();

  await choose(page, "Spring 2027");
  const preview = page.getByRole("region", { name: "Fall 2026 to Spring 2027" });
  await expect(preview).toContainText("4 teams and 2 divisions will be created. 1 teams and 0 divisions are excluded.");
  await expect(preview.getByRole("listitem").filter({ hasText: "Coach and staff assignments" })).toBeVisible();
  await expect(preview.getByRole("listitem").filter({ hasText: "Guardian links" })).toBeVisible();
  await expect(preview.getByRole("row", { name: /Wolves/ })).toContainText("Archived, not copied");
  await expect(preview.getByLabel("Copy Wolves")).toBeDisabled();

  // Deselecting a team invalidates the preview until it is run again.
  await preview.getByLabel("Copy Herons").uncheck();
  await expect(preview.getByRole("status")).toContainText("The selection changed");
  await expect(preview.getByRole("button", { name: "Create draft season" })).toBeDisabled();
  await page.getByRole("button", { name: "Preview rollover" }).click();
  await expect(preview).toContainText("3 teams and 2 divisions will be created. 2 teams and 0 divisions are excluded.");
  await expect(preview.getByRole("row", { name: /Herons/ })).toContainText("Not selected");
  await capture(page, "rollover-preview");

  // A source edit after the preview rejects the commit.
  await db.doc("teams/foxes").update({ name: "Foxes FC", revision: 2 });
  await preview.getByRole("button", { name: "Create draft season" }).click();
  await expect(page.getByRole("alert")).toContainText("The source season changed since this preview");
  await expect(page.getByRole("region", { name: "Fall 2026 to Spring 2027" })).toHaveCount(0);

  await page.getByRole("button", { name: "Preview rollover" }).click();
  await expect(preview.getByRole("row", { name: /Foxes FC/ })).toContainText("Copied as a new team");
  await preview.getByRole("button", { name: "Create draft season" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Rollover started for Spring 2027" })).toBeVisible();
  const job = page.getByRole("listitem").filter({ hasText: "Spring 2027" });
  await expect(job).toContainText("Complete, draft season. 3 teams and 2 divisions created.", { timeout: 30000 });

  // The new teams start empty: no coach assignment carries forward.
  const created = await db.collection("teams").where("orgId", "==", orgId).where("previousTeamId", "==", "hawks").get();
  expect(created.size).toBe(1);
  expect((await db.collection("teamMembers").where("teamId", "==", created.docs[0].id).get()).size).toBe(0);
  const season = (await db.doc(`organizations/${orgId}/seasons/${created.docs[0].data().seasonId}`).get()).data();
  expect(season.status).toBe("draft");
});
