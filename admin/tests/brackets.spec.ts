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
const orgId = "browser-bracket";
const owner = "browser-bracket-owner";
const competitionId = "spring-cup";
const scope = { orgId, programId: "youth-soccer", seasonId: "spring", divisionId: "u10" };
const teams = [["bears", "Bears"], ["foxes", "Foxes"], ["hawks", "Hawks"], ["owls", "Owls"], ["wolves", "Wolves"]];
/** Synthetic knockout policy for tests only; not approved league rules. */
const rules = {
  rulesSchemaVersion: 1, points: { win: 3, draw: 0, loss: 0, forfeitWin: 3, forfeitLoss: 0 }, allowDraws: false, forfeitScore: { winner: 1, loser: 0 },
  countedOutcomes: ["played", "forfeit"], tieBreakers: ["tablePoints", "scoreDifferential", "scoresFor", "wins"], scoreDifferentialCap: null, knockoutDeciders: ["penalties"],
};
/** Captures from the top of the first region to the bottom of the last, so evidence shows the bracket beside the correction. */
async function capture(page: Page, name: string, first: string, last: string) {
  if (!process.env.ADMIN_EVIDENCE_DIR) return;
  await mkdir(process.env.ADMIN_EVIDENCE_DIR, { recursive: true });
  await page.evaluate(async () => {
    await document.fonts.ready;
    (document.activeElement as HTMLElement | null)?.blur();
    window.scrollTo(0, 0);
  });
  const top = (await page.getByRole("region", { name: first }).boundingBox())!;
  const bottom = (await page.getByRole("region", { name: last }).boundingBox())!;
  const clip = { x: 0, y: Math.max(top.y - 16, 0), width: 1440, height: bottom.y + bottom.height + 16 - Math.max(top.y - 16, 0) };
  await page.screenshot({ path: path.join(process.env.ADMIN_EVIDENCE_DIR, `${name}.png`), fullPage: true, clip });
}
test.beforeAll(async () => {
  app = initializeApp({ projectId: "demo-team-hangout" }, "bracket-browser");
  db = getFirestore(app);
  await getAuth(app).createUser({ uid: owner, email: `${owner}@example.test`, password: "SyntheticPassword123!", emailVerified: true });
  const now = Timestamp.now();
  const meta = { schemaVersion: 2, revision: 1, status: "active", createdAt: now, updatedAt: now };
  await db.doc(`users/${owner}`).set({ uid: owner, appRole: "user" });
  await db.doc(`organizations/${orgId}`).set({
    ...meta, orgId, name: "Cedar Youth League", kind: "club", timeZone: "America/Chicago",
    features: { organizationV2: true, adminWorkspace: true, households: true },
  });
  await db.doc(`organizations/${orgId}/members/${owner}`).set({ ...meta, orgId, roles: ["orgAdmin"], programIds: [] });
  await db.doc(`organizations/${orgId}/programs/${scope.programId}`).set({ ...meta, orgId, name: "Youth Soccer", sportCode: "soccer", sportLabel: null, ageBandLabel: null });
  await db.doc(`organizations/${orgId}/seasons/${scope.seasonId}`).set({ ...meta, orgId, programId: scope.programId, name: "Spring 2026", startsOn: "2026-03-01", endsOn: "2026-06-30" });
  await db.doc(`organizations/${orgId}/divisions/${scope.divisionId}`).set({ ...meta, orgId, programId: scope.programId, seasonId: scope.seasonId, name: "Under 10" });
  for (const [id, name] of teams) await db.doc(`teams/${id}`).set({ ...meta, ...scope, name, sport: null, inviteCode: id.toUpperCase().padEnd(8, "X") });
  // A confirmed knockout competition, as saveCompetitionRules would store it.
  await db.doc(`organizations/${orgId}/competitions/${competitionId}`).set({
    schemaVersion: 2, orgId, competitionId, ...scope, format: "knockout", state: "active", name: "Spring Cup", teamIds: teams.map(([id]) => id),
    draftRules: rules, activeRules: rules, activeRulesVersion: 1, rulesVersionCount: 1, sourceRevision: 0, finalResultCount: 0,
    standingsPendingSince: now, revision: 1, createdAt: now, createdBy: owner, updatedAt: now, updatedBy: owner,
  });
  await db.doc(`organizations/${orgId}/competitions/${competitionId}/rulesVersions/1`).set({
    schemaVersion: 2, orgId, competitionId, version: 1, rules, format: "knockout", confirmedBy: owner, confirmedAt: now,
  });
  const match = (eventId: string, home: string, away: string, day: number) => db.doc(`events/${eventId}`).set({
    ...meta, ...scope, title: `${home} vs ${away}`, type: "match", teamId: home, teamIds: [home, away], homeTeamId: home, awayTeamId: away,
    startsAt: Timestamp.fromDate(new Date(`2026-04-${String(day).padStart(2, "0")}T15:00:00Z`)),
    endsAt: Timestamp.fromDate(new Date(`2026-04-${String(day).padStart(2, "0")}T16:30:00Z`)),
    timeZone: "America/Chicago", status: "scheduled", publicationState: "published", publicationOperationId: null, deletedAt: null,
  });
  await match("owls-wolves", "owls", "wolves", 4);
  await match("foxes-hawks", "foxes", "hawks", 11);
  await match("bears-owls", "bears", "owls", 11);
});
test.afterAll(async () => {
  await deleteApp(app);
});

test("a manager publishes seeds with byes, links matches, advances winners and confirms a blocked correction", async ({ page }) => {
  await page.goto(`/organizations/${orgId}/competition?program=${scope.programId}`);
  await page.getByLabel("Email address").fill(`${owner}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill("SyntheticPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Spring Cup" }).click();
  const bracket = page.getByRole("region", { name: "Bracket" });
  const results = page.getByRole("region", { name: "Match results" });
  const game = (name: string) => bracket.getByRole("listitem", { name });

  // Manual seeding needs a reason; the preview shows byes before anything is published.
  await expect(bracket.getByRole("button", { name: "Preview bracket" })).toBeDisabled();
  await bracket.getByLabel("Reason for this order").fill("Seeds drawn at the managers meeting");
  await bracket.getByRole("button", { name: "Preview bracket" }).click();
  await expect(bracket.getByText("Bears advances on a bye. No game is played.")).toBeVisible();
  // Changing an input hides the preview until it is checked again.
  await bracket.getByRole("button", { name: "Move Wolves up" }).click();
  await expect(bracket.getByRole("button", { name: "Publish bracket" })).toHaveCount(0);
  await bracket.getByRole("button", { name: "Move Owls up" }).click();
  await bracket.getByRole("button", { name: "Preview bracket" }).click();
  await bracket.getByRole("button", { name: "Publish bracket" }).click();
  await expect(page.getByText("Bracket published.")).toBeVisible();
  await expect(game("Quarterfinals game 1")).toContainText("Bears advances on a bye. No game is played.");
  await expect(game("Semifinals game 1")).toContainText("Waiting for earlier winners.");

  await game("Quarterfinals game 2").getByLabel("Canonical match").selectOption("owls-wolves");
  await game("Quarterfinals game 2").getByRole("button", { name: "Link match" }).click();
  await expect(game("Quarterfinals game 2")).toContainText("Winner unresolved. Waiting for a final result.");
  await game("Semifinals game 2").getByLabel("Canonical match").selectOption("foxes-hawks");
  await game("Semifinals game 2").getByRole("button", { name: "Link match" }).click();
  await expect(game("Semifinals game 2")).toContainText("Winner unresolved. Waiting for a final result.");

  await results.getByRole("row", { name: /Owls vs Wolves/ }).getByRole("button", { name: "Finalize" }).click();
  await page.getByLabel("Owls score").fill("2");
  await page.getByLabel("Wolves score").fill("1");
  await page.getByRole("button", { name: "Finalize result" }).click();
  await expect(page.getByText("Result finalized.")).toBeVisible();
  await expect(game("Quarterfinals game 2")).toContainText("Owls advanced.");
  await game("Semifinals game 1").getByLabel("Canonical match").selectOption("bears-owls");
  await game("Semifinals game 1").getByRole("button", { name: "Link match" }).click();
  await expect(game("Semifinals game 1")).toContainText("Winner unresolved. Waiting for a final result.");
  await results.getByRole("row", { name: /Bears vs Owls/ }).getByRole("button", { name: "Finalize" }).click();
  await page.getByLabel("Bears score").fill("3");
  await page.getByLabel("Owls score").fill("0");
  await page.getByRole("button", { name: "Finalize result" }).click();
  await expect(game("Semifinals game 1")).toContainText("Bears advanced.");

  // The semifinal was played, so changing the quarterfinal winner needs an explicit, audited confirmation.
  await results.getByRole("row", { name: /Owls vs Wolves/ }).getByRole("button", { name: "Correct" }).click();
  await page.getByLabel("Owls score").fill("1");
  await page.getByLabel("Wolves score").fill("2");
  await page.getByLabel("Correction reason").fill("Referee sheet had the scores reversed");
  await page.getByRole("button", { name: "Check bracket impact" }).click();
  await expect(page.getByText("The winner changes from Owls to Wolves.")).toBeVisible();
  await expect(page.getByText(/Semifinals game 1: already started \(Bears advanced\)/)).toBeVisible();
  await capture(page, "bracket-blocked-correction", "Bracket", "Correct final result");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(page.getByLabel("I confirm invalidating the started games listed above. This is recorded with the reason.")).toBeFocused();
  await page.getByLabel("I confirm invalidating the started games listed above. This is recorded with the reason.").check();
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(page.getByText("Correction saved with its reason in the history.")).toBeVisible();
  await expect(game("Semifinals game 1")).toContainText("Wolves");
  await expect(game("Semifinals game 1")).toContainText("A played match was invalidated by a reviewed correction");

  const node = (await db.doc(`organizations/${orgId}/competitions/${competitionId}/bracketNodes/r2-01`).get()).data();
  expect([node.teamIds, node.winnerTeamId, node.eventId]).toEqual([["bears", "wolves"], null, null]);
  expect(node.voidedPlays.map((play: { eventId: string }) => play.eventId)).toEqual(["bears-owls"]);
  const events = await db.collection("events").where("orgId", "==", orgId).get();
  expect(events.size).toBe(3);
});
