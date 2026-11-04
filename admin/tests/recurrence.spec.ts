import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
const require = createRequire(
  new URL("../../functions/package.json", import.meta.url),
);
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
if (
  process.env.ADMIN_EMULATOR_TESTS !== "1" ||
  process.env.GCLOUD_PROJECT !== "demo-team-hangout" ||
  process.env.FIRESTORE_EMULATOR_HOST !== "127.0.0.1:8080"
)
  throw new Error("Use the isolated admin emulator harness.");
test.describe.configure({ mode: "serial" });
let app: ReturnType<typeof initializeApp>, db: ReturnType<typeof getFirestore>;
const orgId = "browser-recurrence",
  uid = "recurrence-owner",
  password = "SyntheticPassword123!";
const meta = { schemaVersion: 2, revision: 1, status: "active" };
test.beforeAll(async () => {
  app = initializeApp({ projectId: "demo-team-hangout" });
  db = getFirestore(app);
  for (const user of [uid, "recurrence-support"]) {
    await getAuth(app).createUser({
      uid: user,
      email: `${user}@example.test`,
      password,
    });
    await db
      .doc(`users/${user}`)
      .set({ uid: user, appRole: user === uid ? "user" : "superAdmin" });
  }
  await db.doc(`organizations/${orgId}`).set({
    ...meta,
    name: "Cedar Park Athletics",
    timeZone: "America/Chicago",
    features: { organizationV2: true, adminWorkspace: true },
  });
  await db
    .doc(`organizations/${orgId}/members/${uid}`)
    .set({ ...meta, orgId, roles: ["orgAdmin"], programIds: [] });
  const scope = {
    orgId,
    programId: "recurrence-program",
    seasonId: "recurrence-season",
    divisionId: "recurrence-division",
  };
  for (const [kind, id] of [
    ["programs", "recurrence-program"],
    ["seasons", "recurrence-season"],
    ["divisions", "recurrence-division"],
  ])
    await db.doc(`organizations/${orgId}/${kind}/${id}`).set({
      ...meta,
      ...scope,
      name: id,
      startsOn: "2035-01-01",
      endsOn: "2035-12-31",
    });
  await db
    .doc("teams/recurrence-team")
    .set({ ...meta, ...scope, name: "Falcons", sport: "soccer" });
});
test.afterAll(async () => {
  await deleteApp(app);
});
async function open(page: Page, user = uid) {
  await page.goto(`/organizations/${orgId}/recurrence`);
  await page.getByLabel("Email address").fill(`${user}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}
async function fill(page: Page) {
  await page.getByLabel("Team ID", { exact: true }).fill("recurrence-team");
  await page.getByLabel("Practice title").fill("Falcons Sunday practice");
  await page.getByLabel("First local date").fill("2035-11-04");
  await page.getByLabel("Last local date").fill("2035-11-18");
  await page.getByLabel("Local start time").fill("01:30");
}
test("finite preview, repeated-time correction, save, reload and revision retain IDs", async ({
  page,
}) => {
  await open(page);
  await expect(page.getByLabel("IANA timezone")).toHaveValue("America/Chicago");
  await fill(page);
  await page.getByRole("button", { name: "Preview finite range" }).click();
  await expect(
    page.getByText(
      "Choose an explicit UTC offset for this repeated local time.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save reviewed draft" }),
  ).toHaveCount(0);
  await page.getByLabel("UTC offset for Sunday, Nov 4").selectOption("-360");
  await expect(
    page.getByRole("heading", { name: /Review \d+ occurrences/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Preview finite range" }).click();
  await expect(
    page.getByText("Sunday, Nov 4 at 7:30 AM UTC", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("I reviewed this finite range", { exact: false })
    .check();
  await page.getByRole("button", { name: "Save reviewed draft" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Saved reviewed draft revision 1",
  );
  const rows = await db
    .collection(`organizations/${orgId}/scheduleSeries`)
    .get();
  const row = rows.docs[0];
  const firstId = row.data().occurrences[0].id;
  await expect(page.getByRole("status")).toContainText(
    "No events were published or reserved",
  );
  await page.reload();
  await page.getByLabel("Existing series ID").fill(row.id);
  await page.getByRole("button", { name: "Load draft", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "Loaded draft revision 1",
  );
  await expect(page.getByLabel("Team ID", { exact: true })).toBeDisabled();
  await page.getByLabel("Practice title").fill("Updated practice");
  await page.getByRole("button", { name: "Preview finite range" }).click();
  await page
    .getByLabel("I reviewed this finite range", { exact: false })
    .check();
  await page.getByRole("button", { name: "Save reviewed draft" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Saved reviewed draft revision 2",
  );
  expect((await row.ref.get()).data().occurrences[0].id).toBe(firstId);
  expect(
    (await db.collection("events").where("orgId", "==", orgId).get()).size,
  ).toBe(0);
});
test("gap and malformed range guidance, edits invalidate review and stale saves preserve correction", async ({
  page,
}) => {
  await open(page);
  await fill(page);
  await page.getByLabel("First local date").fill("2035-03-04");
  await page.getByLabel("Last local date").fill("2035-03-18");
  await page.getByLabel("Local start time").fill("02:30");
  await page.getByRole("button", { name: "Preview finite range" }).click();
  await expect(page.getByText(/This local time does not exist/)).toBeVisible();
  await page
    .getByLabel("Excluded dates, separated by commas")
    .fill("2035-03-11");
  await page.getByRole("button", { name: "Preview finite range" }).click();
  await expect(
    page.getByRole("heading", { name: "Review 2 occurrences" }),
  ).toBeVisible();
  await page
    .getByLabel("I reviewed this finite range", { exact: false })
    .check();
  await page.getByLabel("Practice title").fill("Corrected gap");
  await expect(
    page.getByRole("button", { name: "Save reviewed draft" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Preview finite range" }).click();
  await page
    .getByLabel("I reviewed this finite range", { exact: false })
    .check();
  await db
    .doc(`organizations/${orgId}/seasons/recurrence-season`)
    .update({ revision: 2 });
  await page.getByRole("button", { name: "Save reviewed draft" }).click();
  await expect(page.getByRole("alert")).toContainText("preview changed");
  await expect(page.getByLabel("Practice title")).toHaveValue("Corrected gap");
  await page.getByLabel("Last local date").fill("2035-12-31");
  await page.getByRole("button", { name: "Preview finite range" }).click();
  await expect(page.getByRole("alert")).toContainText("16 weeks");
});
test("uncertain save retries the exact request and freezes input; revocation clears a pending preview", async ({
  page,
}) => {
  await open(page);
  await fill(page);
  await page.getByLabel("Local start time").fill("17:00");
  await page.getByRole("button", { name: "Preview finite range" }).click();
  await page
    .getByLabel("I reviewed this finite range", { exact: false })
    .check();
  const requests: unknown[] = [];
  let first = true;
  await page.route("**/saveRecurrenceDraft", async (route) => {
    requests.push(route.request().postDataJSON());
    if (first) {
      first = false;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Save reviewed draft" }).click();
  await expect(
    page.getByRole("button", { name: "Retry same action" }),
  ).toBeVisible();
  await expect(page.getByLabel("Practice title")).toBeDisabled();
  await page.getByRole("button", { name: "Retry same action" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Saved reviewed draft revision 1",
  );
  expect(requests[0]).toEqual(requests[1]);
  let release!: () => void, held!: () => void;
  const wait = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (held = r));
  await page.route("**/previewRecurrenceDraft", async (route) => {
    const response = await route.fetch();
    held();
    await wait;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Preview finite range" }).click();
  await ready;
  await db
    .doc(`organizations/${orgId}/members/${uid}`)
    .update({ status: "revoked" });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("alert")).toContainText("Access unavailable");
  release();
  await expect(page.getByLabel("Practice title")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: /Review \d+ occurrences/ }),
  ).toHaveCount(0);
  await db
    .doc(`organizations/${orgId}/members/${uid}`)
    .update({ status: "active" });
});
test("platform support cannot enter tenant draft workspace", async ({
  page,
}) => {
  await open(page, "recurrence-support");
  await expect(page.getByRole("alert")).toContainText("Access unavailable");
  await expect(page.getByLabel("Practice title")).toHaveCount(0);
});
test("focus denial still clears tenant data when an edit happens during authorization", async ({
  page,
}) => {
  await open(page);
  await fill(page);
  let release!: () => void, held!: () => void;
  const wait = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (held = r));
  await db
    .doc(`organizations/${orgId}/members/${uid}`)
    .update({ status: "revoked" });
  await page.route("**/getAdminWorkspace", async (route) => {
    const response = await route.fetch();
    held();
    await wait;
    await route.fulfill({ response });
  });
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await ready;
  await page
    .getByLabel("Practice title")
    .fill("Edit during focus authorization");
  release();
  await expect(page.getByRole("alert")).toContainText("Access unavailable");
  await expect(page.getByLabel("Practice title")).toHaveCount(0);
  await db
    .doc(`organizations/${orgId}/members/${uid}`)
    .update({ status: "active" });
});
