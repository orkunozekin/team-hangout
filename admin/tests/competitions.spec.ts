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
const orgId = "browser-competition";
const owner = "browser-competition-owner";
const scope = { orgId, programId: "youth-soccer", seasonId: "spring", divisionId: "u10" };
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
test.beforeAll(async () => {
  app = initializeApp({ projectId: "demo-team-hangout" }, "competition-browser");
  db = getFirestore(app);
  await getAuth(app).createUser({ uid: owner, email: `${owner}@example.test`, password: "SyntheticPassword123!", emailVerified: true });
  const meta = { schemaVersion: 2, revision: 1, status: "active", createdAt: Timestamp.now(), updatedAt: Timestamp.now() };
  await db.doc(`users/${owner}`).set({ uid: owner, appRole: "user" });
  await db.doc(`organizations/${orgId}`).set({
    ...meta, orgId, name: "Cedar Youth League", kind: "club", timeZone: "America/Chicago",
    features: { organizationV2: true, adminWorkspace: true, households: true },
  });
  await db.doc(`organizations/${orgId}/members/${owner}`).set({ ...meta, orgId, roles: ["orgAdmin"], programIds: [] });
  await db.doc(`organizations/${orgId}/programs/${scope.programId}`).set({ ...meta, orgId, name: "Youth Soccer", sportCode: "soccer", sportLabel: null, ageBandLabel: null });
  await db.doc(`organizations/${orgId}/seasons/${scope.seasonId}`).set({ ...meta, orgId, programId: scope.programId, name: "Spring 2026", startsOn: "2026-03-01", endsOn: "2026-06-30" });
  await db.doc(`organizations/${orgId}/divisions/${scope.divisionId}`).set({ ...meta, orgId, programId: scope.programId, seasonId: scope.seasonId, name: "Under 10" });
  for (const [id, name] of [["hawks", "Hawks"], ["owls", "Owls"], ["foxes", "Foxes"]]) {
    await db.doc(`teams/${id}`).set({ ...meta, ...scope, name, sport: null, inviteCode: id.toUpperCase().padEnd(8, "X") });
  }
  const match = (eventId: string, home: string, away: string, day: number) => db.doc(`events/${eventId}`).set({
    ...meta, ...scope, title: `${home} vs ${away}`, type: "match", teamId: home, teamIds: [home, away], homeTeamId: home, awayTeamId: away,
    startsAt: Timestamp.fromDate(new Date(`2026-04-${String(day).padStart(2, "0")}T15:00:00Z`)),
    endsAt: Timestamp.fromDate(new Date(`2026-04-${String(day).padStart(2, "0")}T16:30:00Z`)),
    timeZone: "America/Chicago", status: "scheduled", publicationState: "published", publicationOperationId: null, deletedAt: null,
  });
  await match("hawks-owls", "hawks", "owls", 4);
  await match("foxes-hawks", "foxes", "hawks", 11);
});
test.afterAll(async () => {
  await deleteApp(app);
});

test("a manager confirms explicit rules and finalizes and corrects a coach proposal", async ({ page }) => {
  await page.goto(`/organizations/${orgId}/competition?program=${scope.programId}`);
  await login(page);
  await expect(page.getByRole("heading", { name: "Competitions and results" })).toBeVisible();
  await page.getByRole("button", { name: "New competition" }).click();
  await page.getByLabel("Name").fill("Spring League");
  await page.getByLabel("Division").selectOption(scope.divisionId);
  for (const team of ["Hawks", "Owls", "Foxes"]) await page.getByLabel(team, { exact: true }).check();
  await page.getByLabel("Score differential cap per result").fill("5");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved. It is not active until confirmed.")).toBeVisible();
  await expect(page.getByText("Rules are a draft. Results cannot be finalized until a competition manager confirms league policy.")).toBeVisible();

  // A coach proposes a score; the scorer cannot finalize under draft rules.
  const competitionId = (await db.collection(`organizations/${orgId}/competitions`).get()).docs[0].id;
  await db.doc(`organizations/${orgId}/competitions/${competitionId}/results/hawks-owls`).set({
    schemaVersion: 2, orgId, competitionId, eventId: "hawks-owls", homeTeamId: "hawks", awayTeamId: "owls", status: "proposed", revision: 1,
    eventStartsAt: Timestamp.fromDate(new Date("2026-04-04T15:00:00Z")), final: null, createdAt: Timestamp.now(), updatedAt: Timestamp.now(), updatedBy: "coach",
    proposal: { outcome: "played", homeScore: 2, awayScore: 1, forfeitingTeamId: null, winnerTeamId: "hawks", decider: null, proposedBy: "coach", proposedTeamId: "hawks", proposedAt: Timestamp.now() },
  });
  await page.reload();
  await page.getByRole("button", { name: "Spring League" }).click();
  await page.getByRole("button", { name: "Finalize" }).first().click();
  await page.getByRole("button", { name: "Finalize result" }).click();
  await expect(page.getByText("A competition manager must confirm the league rules before results become final.")).toBeVisible();

  await page.getByRole("button", { name: "Confirm rules" }).click();
  // The policy confirmation checkbox is required before submission.
  await expect(page.getByText("Rules confirmed as league policy.")).toHaveCount(0);
  await page.getByLabel("I confirm these rules match our approved league policy.").check();
  await page.getByRole("button", { name: "Confirm rules" }).click();
  await expect(page.getByText("Rules confirmed as league policy.")).toBeVisible();
  await expect(page.getByText("Confirmed rules version 1 is active. Results finalize under this version.")).toBeVisible();

  const results = page.getByRole("region", { name: "Match results" });
  await expect(results.getByText("Pending proposal: 2-1")).toBeVisible();
  await results.getByRole("row", { name: /Hawks vs Owls/ }).getByRole("button", { name: "Finalize" }).click();
  await expect(page.getByText("Coach proposal: 2-1")).toBeVisible();
  await page.getByRole("button", { name: "Finalize result" }).click();
  await expect(page.getByText("Result finalized.")).toBeVisible();
  await expect(results.getByText("Final: 2-1")).toBeVisible();

  await results.getByRole("row", { name: /Hawks vs Owls/ }).getByRole("button", { name: "Correct" }).click();
  await page.getByLabel("Owls score").fill("2");
  await page.getByLabel("Correction reason").fill("Referee sheet shows a late equalizer");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(page.getByText("Correction saved with its reason in the history.")).toBeVisible();
  await expect(results.getByText("Final: 2-2 (corrected)")).toBeVisible();
  await capture(page, "competition-rules-and-results");

  const history = await db.collection(`organizations/${orgId}/competitions/${competitionId}/resultHistory`).orderBy("afterRevision").get();
  expect(history.docs.map((row: any) => row.data().kind)).toEqual(["finalize", "correct"]);
  expect(history.docs[1].data().reason).toBe("Referee sheet shows a late equalizer");
});

test("a knockout competition rejects a tied score without a permitted decider", async ({ page }) => {
  await page.goto(`/organizations/${orgId}/competition?program=${scope.programId}`);
  await login(page);
  await page.getByRole("button", { name: "New competition" }).click();
  await page.getByLabel("Name").fill("Spring Cup");
  await page.getByLabel("Format").selectOption("knockout");
  await page.getByLabel("Hawks", { exact: true }).check();
  await page.getByLabel("Foxes", { exact: true }).check();
  await page.getByLabel("I confirm these rules match our approved league policy.").check();
  await page.getByRole("button", { name: "Confirm rules" }).click();
  await expect(page.getByText("Choose at least one decider for tied matches when draws are not allowed.")).toBeVisible();
  await page.getByLabel("Penalties").check();
  await page.getByRole("button", { name: "Confirm rules" }).click();
  await expect(page.getByText("Rules confirmed as league policy.")).toBeVisible();
  const results = page.getByRole("region", { name: "Match results" });
  await results.getByRole("row", { name: /Foxes vs Hawks/ }).getByRole("button", { name: "Finalize" }).click();
  // "01" and "1" are a tie once parsed.
  await page.getByLabel("Foxes score").fill("01");
  await page.getByLabel("Hawks score").fill("1");
  await page.getByRole("button", { name: "Finalize result" }).click();
  await expect(page.getByText("A knockout match cannot end in a draw. Record the winner and the decider the rules allow.")).toBeVisible();
  await page.getByLabel("Winner after tie").selectOption("hawks");
  await page.getByLabel("Decided by").selectOption("penalties");
  await page.getByRole("button", { name: "Finalize result" }).click();
  await expect(results.getByText("Final: 1-1, Hawks won on penalties")).toBeVisible();
});
