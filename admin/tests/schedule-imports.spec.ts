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
const orgId = "browser-schedules";
const uid = "browser-schedule-owner";
const head =
  "externalId,teamExternalId,eventType,title,localDate,localStartTime,localEndTime,timeZone,startOffset,endOffset,locationName,address,notes";
async function capture(page: Page, name: string) {
  if (process.env.ADMIN_EVIDENCE_DIR) {
    await mkdir(process.env.ADMIN_EVIDENCE_DIR, { recursive: true });
    await page.evaluate(async () => {
      await document.fonts.ready;
      window.scrollTo(0, 0);
    });
    await page.screenshot({
      path: path.join(process.env.ADMIN_EVIDENCE_DIR, `${name}.png`),
      fullPage: (page.viewportSize()?.width || 1440) > 500,
    });
  }
}
async function open(page: Page) {
  await page.goto(`/organizations/${orgId}/schedule`);
  await page.getByLabel("Email address").fill(`${uid}@example.test`);
  await page
    .getByLabel("Password", { exact: true })
    .fill("SyntheticPassword123!");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Upload and map a CSV" }),
  ).toBeVisible();
}
async function upload(page: Page, body: string) {
  await page
    .getByRole("combobox", { name: "Program", exact: true })
    .selectOption("schedule-program");
  await page
    .getByRole("combobox", { name: "Target season", exact: true })
    .selectOption("schedule-season");
  await page.getByLabel("CSV file").setInputFiles({
    name: "schedule.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`${head}\r\n${body}`),
  });
  await page.getByRole("button", { name: "Upload for server preview" }).click();
  await expect(page.getByText(/^preview · Previewed/)).toBeVisible({
    timeout: 45000,
  });
}
async function confirm(page: Page) {
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Confirm and commit drafts" }).click();
  await expect(page.getByText(/^complete · Previewed/)).toBeVisible({
    timeout: 45000,
  });
}
test.beforeAll(async () => {
  app = initializeApp({ projectId: "demo-team-hangout" }, "import-browser");
  db = getFirestore(app);
  await getAuth(app).createUser({
    uid,
    email: `${uid}@example.test`,
    password: "SyntheticPassword123!",
  });
  await db.doc(`users/${uid}`).set({ uid, appRole: "user" });
  const meta = {
    schemaVersion: 2,
    revision: 1,
    orgId,
    status: "active",
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    createdBy: uid,
    updatedBy: uid,
  };
  await db.doc(`organizations/${orgId}`).set({
    ...meta,
    name: "Cedar Park Athletics",
    kind: "club",
    features: {
      adminWorkspace: true,
      organizationV2: true,
      imports: true,
      households: true,
    },
  });
  await db
    .doc(`organizations/${orgId}/members/${uid}`)
    .set({ ...meta, roles: ["orgAdmin"], programIds: [] });
  await db
    .doc(`organizations/${orgId}/programs/schedule-program`)
    .set({ ...meta, name: "Soccer", sportCode: "soccer" });
  await db.doc(`organizations/${orgId}/seasons/schedule-season`).set({
    ...meta,
    programId: "schedule-program",
    name: "Fall 2026",
    startsOn: "2026-09-01",
    endsOn: "2026-12-31",
  });
  await db.doc(`organizations/${orgId}/divisions/schedule-division`).set({
    ...meta,
    programId: "schedule-program",
    seasonId: "schedule-season",
    name: "U12",
  });
  await db.doc("teams/browser-schedule-team").set({
    ...meta,
    programId: "schedule-program",
    seasonId: "schedule-season",
    divisionId: "schedule-division",
    name: "Falcons",
    externalId: "U12",
  });
  await db.doc(`organizations/${orgId}/participants/browser-old-identity`).set({
    ...meta,
    displayName: "Jamie Example",
    kind: "youth",
    linkedUserId: null,
  });
  const parentUid = "browser-schedule-parent";
  await getAuth(app).createUser({
    uid: parentUid,
    email: `${parentUid}@example.test`,
    emailVerified: true,
  });
  await db.doc(`users/${parentUid}`).set({ uid: parentUid, appRole: "user" });
  await db
    .doc(`organizations/${orgId}/participants/browser-schedule-child`)
    .set({
      ...meta,
      displayName: "Casey Example",
      kind: "youth",
      linkedUserId: null,
    });
  await db
    .doc(
      `organizations/${orgId}/participants/browser-schedule-child/guardians/${parentUid}`,
    )
    .set({
      ...meta,
      participantId: "browser-schedule-child",
      userId: parentUid,
      permissions: { viewSchedule: true },
    });
  await db
    .doc("teams/browser-schedule-team/roster/browser-schedule-child")
    .set({ ...meta, participantId: "browser-schedule-child" });
});
test.afterAll(async () => deleteApp(app));

const line = (
  id: string,
  title = "Evening practice",
  date = "2026-10-20",
  start = "17:00",
  end = "18:00",
) =>
  [
    id,
    "U12",
    "practice",
    title,
    date,
    start,
    end,
    "America/Chicago",
    "",
    "",
    "Cedar Park field",
    "123 Example Lane",
    "Bring water",
  ].join(",");
test("schedule drafts require a separate publication confirmation and retained publication retry queues once", async ({
  page,
}) => {
  await open(page);
  await capture(page, "01-schedule-empty");
  await upload(
    page,
    [
      line("ui-fold", "DST fold", "2026-11-01", "01:15", "02:15"),
      line("ui-stable"),
      line(
        "ui-overlap",
        "Overlapping practice",
        "2026-10-20",
        "17:30",
        "18:30",
      ),
    ].join("\n"),
  );
  await expect(page.getByText(/Ambiguous local time/)).toBeVisible();
  await expect(
    page.getByText(/Possible overlap with another source row/).first(),
  ).toBeVisible();
  await capture(page, "02-schedule-dst-overlap-review");
  await page.getByRole("button", { name: "Skip row 1", exact: true }).click();
  await expect(page.getByText(/Needs resolution 0/)).toBeVisible();
  await page.getByRole("checkbox").check();
  await capture(page, "03-schedule-draft-confirmation");
  await page.getByRole("button", { name: "Confirm and commit drafts" }).click();
  await expect(page.getByText(/^complete · Previewed/)).toBeVisible({
    timeout: 45000,
  });
  const jobId = await page.getByLabel("Import job ID").inputValue();
  const rows = await db
    .collection(`importJobs/${jobId}/rows`)
    .orderBy("number")
    .get();
  const eventId = rows.docs[1].data().eventId;
  expect(
    (await db.doc(`events/${eventId}`).get()).data().publicationState,
  ).toBe("staged");
  expect(
    (await db.collection("emailOutbox").where("eventId", "==", eventId).get())
      .size,
  ).toBe(0);
  await capture(page, "04-schedule-unpublished-drafts");
  await page.getByLabel("Select draft row 2 for publication").check();
  await page
    .getByRole("button", { name: "Review selected publication" })
    .click();
  await expect(
    page.getByRole("button", { name: "Confirm publication and queue updates" }),
  ).toBeDisabled();
  await expect(
    page.getByText(/Publish 1 events and queue 1 essential updates/),
  ).toBeVisible();
  await page
    .getByLabel(
      "I confirm these exact drafts and essential update counts for publication.",
    )
    .check();
  await capture(page, "05-schedule-publication-confirmation");
  let lost = false;
  const payloads: string[] = [];
  await page.route("**/publishScheduleImport", async (route) => {
    payloads.push(route.request().postData() || "");
    const response = await route.fetch();
    if (!lost) {
      lost = true;
      await route.abort("failed");
    } else await route.fulfill({ response });
  });
  await page
    .getByRole("button", { name: "Confirm publication and queue updates" })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Retry publication with the same request",
    }),
  ).toBeVisible({ timeout: 45000 });
  await capture(page, "06-schedule-publication-retained-retry");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page
    .getByRole("button", { name: "Retry publication with the same request" })
    .click();
  await expect(
    page.getByText("1 events published; 1 essential updates queued.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(payloads.length).toBe(2);
  expect(payloads[0]).toBe(payloads[1]);
  await expect(
    page.getByText("Published revision 2", { exact: true }),
  ).toBeVisible();
  expect((await db.doc(`events/${eventId}`).get()).data().revision).toBe(2);
  expect(
    (await db.collection("emailOutbox").where("eventId", "==", eventId).get())
      .size,
  ).toBe(1);
  await capture(page, "07-schedule-published");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await capture(page, "08-schedule-mobile");
  await page
    .getByRole("heading", { name: "Separately publish selected drafts" })
    .scrollIntoViewIfNeeded();
  if (process.env.ADMIN_EVIDENCE_DIR)
    await page.screenshot({
      path: path.join(
        process.env.ADMIN_EVIDENCE_DIR,
        "11-schedule-mobile-publication.png",
      ),
      fullPage: false,
    });
  await page.reload();
  await page.getByLabel("Import job ID").fill(jobId);
  await page.getByRole("button", { name: "Open saved import" }).click();
  await expect(
    page.getByText("Published revision 2", { exact: true }),
  ).toBeVisible();
});
test("schedule stale publication and permission loss leave drafts private", async ({
  page,
}) => {
  await open(page);
  await upload(page, line("ui-stale", "Stale draft review"));
  await confirm(page);
  await page.getByLabel("Select draft row 1 for publication").check();
  await page
    .getByRole("button", { name: "Review selected publication" })
    .click();
  await expect(page.getByText(/Publish 1 events/)).toBeVisible();
  const jobId = await page.getByLabel("Import job ID").inputValue();
  const row = (await db.doc(`importJobs/${jobId}/rows/00001`).get()).data();
  await db
    .doc(`events/${row.eventId}`)
    .update({ title: "Later outside edit", revision: 2 });
  await page
    .getByLabel(
      "I confirm these exact drafts and essential update counts for publication.",
    )
    .check();
  await page
    .getByRole("button", { name: "Confirm publication and queue updates" })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Upload a fresh schedule preview",
  );
  await expect(
    page.getByRole("button", { name: "Confirm publication and queue updates" }),
  ).toHaveCount(0);
  expect(
    (await db.doc(`events/${row.eventId}`).get()).data().publicationState,
  ).toBe("staged");
  await capture(page, "09-schedule-stale-publication");
  await db
    .doc(`organizations/${orgId}/members/${uid}`)
    .update({ status: "revoked" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("Access unavailable");
  await expect(
    page.getByText("Stale draft review", { exact: true }),
  ).toHaveCount(0);
  await capture(page, "10-schedule-access-removed");
  await db
    .doc(`organizations/${orgId}/members/${uid}`)
    .update({ status: "active" });
});
