import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
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
const orgId = "browser-reports";
const owner = "browser-reports-owner";
const scope = { orgId, programId: "youth-soccer", seasonId: "spring", divisionId: null };
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
const at = (value: string) => Timestamp.fromDate(new Date(value));
test.beforeAll(async () => {
  app = initializeApp({ projectId: "demo-team-hangout" }, "reports-browser");
  db = getFirestore(app);
  await getAuth(app).createUser({ uid: owner, email: `${owner}@example.test`, password: "SyntheticPassword123!", emailVerified: true });
  const meta = { schemaVersion: 2, revision: 1, status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now() };
  await db.doc(`users/${owner}`).set({ uid: owner, appRole: "user" });
  await db.doc(`organizations/${orgId}`).set({
    ...meta, orgId, name: "Cedar Youth League", kind: "club", timeZone: "America/Chicago",
    features: { organizationV2: true, adminWorkspace: true, reports: true },
  });
  await db.doc(`organizations/${orgId}/members/${owner}`).set({ ...meta, orgId, roles: ["orgAdmin"], programIds: [] });
  await db.doc(`organizations/${orgId}/programs/${scope.programId}`).set({ ...meta, orgId, name: "Youth Soccer", sportCode: "soccer", sportLabel: null, ageBandLabel: null });
  await db.doc(`organizations/${orgId}/seasons/${scope.seasonId}`).set({ ...meta, orgId, programId: scope.programId, name: "Spring 2026", startsOn: "2026-03-01", endsOn: "2026-06-30" });
  for (const [id, name] of [["hawks", "Hawks"], ["owls", "Owls"]]) {
    await db.doc(`teams/${id}`).set({ ...meta, ...scope, name, sport: null, inviteCode: id.toUpperCase().padEnd(8, "X") });
  }
  const event = (id: string, fields: Record<string, unknown>) => db.doc(`events/${id}`).set({
    ...meta, ...scope, title: `Synthetic ${id}`, type: "practice", timeZone: "America/Chicago", publicationState: "published",
    publicationOperationId: null, deletedAt: null, scheduleVersion: 1, ...fields,
  });
  await event("shared-match", {
    type: "match", teamId: "hawks", teamIds: ["hawks", "owls"], status: "completed", startsAt: at("2026-04-04T15:00:00Z"), endsAt: at("2026-04-04T16:30:00Z"),
    rosterSnapshot: { schemaVersion: 2, capturedRevision: 2, scheduleVersion: 1, participantCount: 9, eligibleCount: 9 },
  });
  await event("hawks-cancelled", { teamId: "hawks", teamIds: ["hawks"], status: "cancelled", startsAt: at("2026-04-07T23:00:00Z"), endsAt: at("2026-04-08T00:00:00Z") });
  await event("owls-open", { teamId: "owls", teamIds: ["owls"], status: "scheduled", startsAt: at("2026-04-09T23:00:00Z"), endsAt: at("2026-04-10T00:00:00Z") });
  const rows: [string, string[], string | null][] = [
    ["h1", ["hawks"], "present"], ["h2", ["hawks"], "late"], ["h3", ["hawks"], "absent"], ["h4", ["hawks"], "excused"],
    ["h5", ["hawks"], "unknown"], ["h6", ["hawks"], null], ["o1", ["owls"], "present"], ["o2", ["owls"], "absent"], ["d1", ["hawks", "owls"], "present"],
  ];
  for (const [participantId, teamIds, status] of rows) {
    await db.doc(`events/shared-match/rosterSnapshots/${participantId}`).set({
      schemaVersion: 2, orgId, eventId: "shared-match", participantId, displayName: `Synthetic ${participantId}`, teamIds, capturedRevision: 2,
      enrollments: teamIds.map((teamId) => ({ teamId, eligible: true, status: "active" })), eligible: true,
    });
    if (status) await db.doc(`events/shared-match/attendance/${participantId}`).set({ schemaVersion: 2, orgId, eventId: "shared-match", participantId, status, scheduleVersion: 1, revision: 1 });
  }
  // Let seed-time source triggers drain before any run starts.
  await new Promise((resolve) => setTimeout(resolve, 3000));
});
test.afterAll(async () => {
  await deleteApp(app);
});

test("staff run an attendance report, see missingness and denominators, then rebuild after a correction", async ({ page }) => {
  await page.goto(`/organizations/${orgId}/reports`);
  await login(page);
  await expect(page.getByRole("heading", { name: "Reports", exact: true })).toBeVisible();
  await page.getByLabel("Program").selectOption(scope.programId);
  await expect(page.getByLabel("Season")).toHaveValue(scope.seasonId);
  await page.getByLabel("From").fill("2026-04-01");
  await page.getByLabel("To").fill("2027-04-02");
  await page.getByRole("button", { name: "Run report" }).click();
  await expect(page.getByRole("alert")).toContainText("at most 366 days");
  await page.getByLabel("To").fill("2026-04-30");
  await page.getByRole("button", { name: "Run report" }).click();
  const detail = page.getByRole("region", { name: "Report detail" });
  await expect(detail.getByRole("status")).toContainText("Complete", { timeout: 30000 });
  const summary = detail.getByRole("row", { name: /All in scope/ });
  // Presence (3 + 1) / (3 + 1 + 2); coverage (4 + 2 + 1) / 9. The dual-rostered player counts once.
  await expect(summary).toContainText("66.7%");
  await expect(summary).toContainText("4 of 6");
  await expect(summary).toContainText("7 of 9");
  await expect(summary).toContainText("1 closed, 1 excluded, 1 awaiting closure");
  await expect(detail.getByRole("row", { name: /Hawks/ })).toContainText("5 of 7");
  await expect(detail.getByRole("row", { name: /Owls/ })).toContainText("100%");
  await expect(detail.getByText("Synthetic h1")).toHaveCount(0);

  await db.doc("events/shared-match/attendance/h6").set({ schemaVersion: 2, orgId, eventId: "shared-match", participantId: "h6", status: "absent", scheduleVersion: 1, revision: 1 });
  await expect(async () => {
    await detail.getByRole("button", { name: "Refresh" }).click();
    await expect(detail.getByRole("status")).toContainText("stale", { timeout: 2000 });
  }).toPass({ timeout: 30000 });
  await expect(detail.getByRole("status")).toContainText("an attendance record was corrected");
  // The stale snapshot keeps its recorded figures.
  await expect(summary).toContainText("4 of 6");
  await capture(page, "reports-attendance-stale");
  // The CSV is the stale snapshot as recorded, labeled stale, with its run, versions and filters.
  const downloading = page.waitForEvent("download");
  await detail.getByRole("button", { name: "Download CSV" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^team-hangout-attendance-2026-04-01-to-2026-04-30-[A-Za-z0-9_-]+\.csv$/);
  const csv = await readFile((await download.path())!, "utf8");
  for (const line of ['"stale","true"', '"staleReason","attendanceCorrected"', '"filter.programId","youth-soccer"', '"filter.fromDate","2026-04-01"', '"timeZone","America/Chicago"', '"exportVersion","1"']) {
    expect(csv).toContain(line);
  }
  expect(csv).toContain('"summary","","All teams","9","3","1","2","1","1","1"');
  expect(csv).not.toContain("Synthetic h1");
  await expect(detail.getByText(/^Downloaded team-hangout-attendance-.* with 2 rows plus the summary, from a stale snapshot\.$/)).toBeVisible();
  await capture(page, "reports-export-download");
  await detail.getByRole("button", { name: "Rebuild from current records" }).click();
  const rebuilt = page.getByRole("region", { name: "Report detail" });
  await expect(rebuilt.getByRole("status")).toContainText("Complete.", { timeout: 30000 });
  await expect(rebuilt.getByRole("row", { name: /All in scope/ })).toContainText("4 of 7");
  await expect(rebuilt).toContainText("Rebuilt from an earlier run.");
});

test("a failed run shows its reason and offers a rebuild instead of figures", async ({ page }) => {
  const interval = { fromDate: "2026-04-01", toDate: "2026-04-30", timeZone: "America/Chicago", days: 30, startsAt: "2026-04-01T05:00:00.000Z", endsAt: "2026-05-01T05:00:00.000Z", hours: 720 };
  await db.doc(`organizations/${orgId}/reportRuns/failed-run`).set({
    schemaVersion: 2, orgId, runId: "failed-run", kind: "attendance", ...scope, teamId: null, facilityId: null,
    filters: { kind: "attendance", programId: scope.programId, seasonId: scope.seasonId, teamId: null, fromDate: "2026-04-01", toDate: "2026-04-30" },
    interval, intervalStartsAt: interval.startsAt, intervalEndsAt: interval.endsAt, reportVersion: 1, reducerVersion: 1, formulas: [], state: "failed", attempts: 1,
    requestedBy: owner, requestedAt: Timestamp.fromDate(new Date("2030-01-01T00:00:00Z")), stale: false, staleReason: null, supersedes: null, supersededBy: null,
    failure: { code: "REPORT_TOO_LARGE", message: "More than 3000 events match. Choose one team or a shorter date range." }, summary: null, manifest: null, rowCount: 0,
  });
  await page.goto(`/organizations/${orgId}/reports`);
  await login(page);
  await page.getByLabel("Program").selectOption(scope.programId);
  await page.getByRole("button", { name: /Failed/ }).first().click();
  const detail = page.getByRole("region", { name: "Report detail" });
  await expect(detail.getByRole("status")).toContainText("Choose one team or a shorter date range.");
  await expect(detail.getByRole("table")).toHaveCount(0);
  await expect(detail.getByRole("button", { name: "Rebuild from current records" })).toBeVisible();
});
