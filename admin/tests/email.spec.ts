import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const require = createRequire(
  new URL("../../functions/package.json", import.meta.url),
);
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
const orgId = "browser-email",
  uid = "browser-email-parent",
  owner = "browser-email-owner";
async function capture(page: Page, name: string) {
  if (!process.env.ADMIN_EVIDENCE_DIR) return;
  await mkdir(process.env.ADMIN_EVIDENCE_DIR, { recursive: true });
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: path.join(process.env.ADMIN_EVIDENCE_DIR, name + ".png"),
    fullPage: (page.viewportSize()?.width || 1440) > 500,
  });
}
async function login(page: Page, id = uid) {
  await page.getByLabel("Email address").fill(`${id}@example.test`);
  await page
    .getByLabel("Password", { exact: true })
    .fill("SyntheticPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
test.beforeAll(async () => {
  app = initializeApp({ projectId: "demo-team-hangout" }, "email-browser");
  db = getFirestore(app);
  for (const id of [uid, owner]) {
    await getAuth(app).createUser({
      uid: id,
      email: `${id}@example.test`,
      password: "SyntheticPassword123!",
      emailVerified: true,
    });
    await db.doc(`users/${id}`).set({ uid: id, appRole: "user" });
  }
  const meta = {
    schemaVersion: 2,
    revision: 1,
    status: "active",
    orgId,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    createdBy: owner,
    updatedBy: owner,
  };
  await db
    .doc(`organizations/${orgId}`)
    .set({
      ...meta,
      name: "Cedar Park Athletics",
      features: {
        households: true,
        organizationV2: true,
        adminWorkspace: true,
      },
    });
  await db
    .doc(`organizations/${orgId}/members/${owner}`)
    .set({ ...meta, roles: ["orgAdmin"], programIds: [] });
  await db
    .doc(`organizations/${orgId}/programs/email-program`)
    .set({ ...meta, name: "Soccer" });
  await db
    .doc(`organizations/${orgId}/seasons/email-season`)
    .set({ ...meta, programId: "email-program", name: "Fall 2026" });
  await db
    .doc(`organizations/${orgId}/divisions/email-division`)
    .set({
      ...meta,
      programId: "email-program",
      seasonId: "email-season",
      name: "U12",
    });
  await db
    .doc("teams/browser-email-team")
    .set({
      ...meta,
      programId: "email-program",
      seasonId: "email-season",
      divisionId: "email-division",
      name: "Falcons",
    });
  await db
    .doc(`organizations/${orgId}/participants/email-child`)
    .set({
      ...meta,
      displayName: "Private child",
      kind: "youth",
      linkedUserId: null,
    });
  await db
    .doc(`organizations/${orgId}/participants/email-child/guardians/${uid}`)
    .set({
      ...meta,
      userId: uid,
      participantId: "email-child",
      permissions: { viewSchedule: true },
    });
  await db
    .doc("teams/browser-email-team/roster/email-child")
    .set({ ...meta, participantId: "email-child" });
  await db
    .doc("events/browser-email-event")
    .set({
      ...meta,
      programId: "email-program",
      seasonId: "email-season",
      divisionId: "email-division",
      teamId: "browser-email-team",
      teamIds: ["browser-email-team"],
      title: "Evening practice",
      type: "practice",
      startsAt: Timestamp.fromDate(new Date("2026-10-20T22:00:00Z")),
      endsAt: Timestamp.fromDate(new Date("2026-10-20T23:00:00Z")),
      timeZone: "America/Chicago",
      location: { name: "Cedar Park field", address: "123 Example Lane" },
      status: "scheduled",
      publicationState: "published",
      publicationOperationId: null,
      deletedAt: null,
    });
  for (const [id, status, failureCode, attemptCount] of [
    ["one", "failed", "AMBIGUOUS", 1],
    ["two", "failed", "BOUNCE", 1],
    ["three", "pending", "PRE_SEND", 2],
    ["four", "sent", null, 1],
    ["five", "cancelled", "SUPPRESSED_OR_STALE", 1],
  ])
    await db
      .doc(`emailOutbox/browser-email-${id}`)
      .set({
        orgId,
        kind: "publishedEvent",
        status,
        failureCode,
        attemptCount,
      });
});
test.afterAll(async () => deleteApp(app));
test("private event requires sign-in and clears content on revoked access, including delayed response races", async ({
  page,
}) => {
  await page.goto("/events/browser-email-event");
  await capture(page, "01-private-event-sign-in");
  await login(page);
  await expect(
    page.getByRole("heading", { name: "Evening practice" }),
  ).toBeVisible();
  await expect(page.getByText("Team: Falcons")).toBeVisible();
  await expect(page.getByText(/5:00 PM/)).toBeVisible();
  await expect(page.getByText("Private child", { exact: true })).toHaveCount(0);
  await capture(page, "02-private-event-authorized");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(page, "03-private-event-mobile");
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  let entered!: () => void;
  const waiting = new Promise<void>((r) => {
    entered = r;
  });
  let delayed = false;
  await page.route("**/getPrivateEventInformation", async (route) => {
    const response = await route.fetch();
    if (!delayed) {
      delayed = true;
      entered();
      await gate;
    }
    await route.fulfill({ response });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await waiting;
  await db
    .doc(`organizations/${orgId}/participants/email-child/guardians/${uid}`)
    .update({ status: "revoked" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("Access unavailable");
  release();
  await expect(
    page.getByRole("heading", { name: "Evening practice" }),
  ).toHaveCount(0);
  await page.waitForTimeout(300);
  await expect(
    page.getByRole("heading", { name: "Evening practice" }),
  ).toHaveCount(0);
  await capture(page, "04-private-event-revoked");
  await db
    .doc(`organizations/${orgId}/participants/email-child/guardians/${uid}`)
    .update({ status: "active" });
});
test("essential preference uses same-request replay and help is app-free", async ({
  page,
}) => {
  await page.goto("/email-preferences");
  await login(page);
  await expect(page.getByText(/Essential email is allowed/)).toBeVisible();
  await capture(page, "05-email-preference-allowed");
  let lost = false;
  const payloads: string[] = [];
  await page.route("**/setEssentialEmailPreference", async (route) => {
    payloads.push(route.request().postData() || "");
    const response = await route.fetch();
    if (!lost) {
      lost = true;
      await route.abort("failed");
    } else await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: "Suppress essential email", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Retry same action", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Retry same action", exact: true })
    .click();
  await expect(page.getByText(/Essential email is suppressed/)).toBeVisible();
  expect(payloads.length).toBe(2);
  expect(payloads[0]).toBe(payloads[1]);
  await capture(page, "06-email-preference-suppressed");
  await page.goto("/help");
  await expect(
    page.getByRole("heading", { name: "Help with team information" }),
  ).toBeVisible();
  await capture(page, "07-email-help");
});
test("staff delivery counts and recovery advice hide recipient addresses and clear on loss of admin scope", async ({
  page,
}) => {
  await page.goto(`/organizations/${orgId}/invitation`);
  await login(page, owner);
  await expect(
    page.getByText("2 failed · 1 pending", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Transport accepted", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/reconcile provider acceptance/)).toBeVisible();
  await capture(page, "08-staff-email-failures");
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("heading", { name: "Essential email delivery" })
    .scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  if (process.env.ADMIN_EVIDENCE_DIR)
    await page.screenshot({
      path: path.join(
        process.env.ADMIN_EVIDENCE_DIR,
        "09-staff-email-mobile.png",
      ),
      fullPage: false,
    });
  await db
    .doc(`organizations/${orgId}/members/${owner}`)
    .update({ status: "revoked" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByText("2 failed · 1 pending", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Transport accepted", { exact: true }),
  ).toHaveCount(0);
  await db
    .doc(`organizations/${orgId}/members/${owner}`)
    .update({ status: "active" });
});
