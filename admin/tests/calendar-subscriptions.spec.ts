import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
// @ts-ignore Synthetic fixture shared with native evidence.
import {
  seedHouseholdDemo,
  householdOrg,
  demoPassword,
} from "../../scripts/seed-household-demo.mjs";
const require = createRequire(
  new URL("../../functions/package.json", import.meta.url),
);
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
if (process.env.ADMIN_EMULATOR_TESTS !== "1")
  throw new Error("Use test:admin with isolated demo emulators.");
test.describe.configure({ mode: "serial" });
let app: any, db: any;
test.beforeAll(async () => {
  await seedHouseholdDemo();
  app = initializeApp({ projectId: "demo-team-hangout" }, "calendar-browser");
  db = getFirestore(app);
  await db
    .doc(`organizations/${householdOrg}`)
    .update({ "features.calendarSubscriptions": true });
  await db.doc("events/calendar-browser-event").set({
    schemaVersion: 2,
    revision: 1,
    orgId: householdOrg,
    programId: "soccer",
    seasonId: "fall",
    divisionId: "u12",
    teamId: "ui-team",
    teamIds: ["ui-team"],
    title: "Community practice",
    type: "practice",
    startsAt: Timestamp.fromMillis(Date.now() + 86400000),
    endsAt: Timestamp.fromMillis(Date.now() + 90000000),
    timeZone: "America/Chicago",
    status: "scheduled",
    publicationState: "published",
    publicationOperationId: null,
    deletedAt: null,
    updatedAt: Timestamp.now(),
  });
});
test.afterAll(async () => {
  await deleteApp(app);
});
async function login(page: Page, uid = "ui-parent") {
  await page.goto("/calendar-subscriptions");
  await page.getByLabel("Email address").fill(`${uid}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill(demoPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Calendar subscriptions", exact: true }),
  ).toBeVisible();
}
async function capture(page: Page, name: string) {
  if (!process.env.ADMIN_EVIDENCE_DIR) return;
  await mkdir(process.env.ADMIN_EVIDENCE_DIR, { recursive: true });
  await page.setViewportSize({
    width: page.viewportSize()!.width,
    height: 1900,
  });
  await expect(page.getByText("Loading calendar access…")).toHaveCount(0);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.screenshot({
    path: `${process.env.ADMIN_EVIDENCE_DIR}/${name}.png`,
    fullPage: false,
  });
}
test("private subscription creation, rotation, revoke and standard feed response", async ({
  page,
  request,
}) => {
  await login(page);
  page.on("dialog", (dialog) => void dialog.accept());
  await expect(page.getByText("No active subscriptions.")).toBeVisible();
  await capture(page, "step11-browser-empty");
  await page.getByRole("checkbox", { name: "Cedar Foxes" }).check();
  await expect(
    page.getByRole("checkbox", {
      name: "Include selected participant names in the feed",
    }),
  ).toBeDisabled();
  await page.getByRole("checkbox", { name: "Jamie Rivera" }).check();
  await page.getByRole("button", { name: "Create private URL" }).click();
  const input = page.getByLabel("Subscription URL");
  await expect(input).toBeVisible();
  const old = await input.inputValue();
  const response = await request.get(old);
  expect(response.status()).toBe(200);
  expect(await response.text()).toContain("Community practice");
  expect(await response.text()).not.toContain("Jamie");
  expect(response.headers()["cache-control"]).toContain("no-store");
  // Capture metadata and instructions without placing even demo bearer URLs in PR screenshots.
  await page.getByRole("button", { name: "Reload subscriptions" }).click();
  await expect(
    page.getByRole("heading", { name: "Subscription 1", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Loading calendar access…")).toHaveCount(0);
  await capture(page, "step11-browser-active");
  await page.getByRole("button", { name: "Rotate URL" }).click();
  await expect(input).toBeVisible();
  const next = await input.inputValue();
  expect(next).not.toEqual(old);
  expect((await request.get(old)).status()).toBe(404);
  await page.getByRole("button", { name: "Remove subscription" }).click();
  await expect(
    page.getByText(
      "URL revoked. Remove the subscribed calendar from your calendar app too.",
    ),
  ).toBeVisible();
  expect((await request.get(next)).status()).toBe(404);
  await expect(page.getByText("No active subscriptions.")).toBeVisible();
  await expect(page.getByText("Loading calendar access…")).toHaveCount(0);
  await capture(page, "step11-browser-revoked");
  await page.setViewportSize({ width: 390, height: 844 });
  await capture(page, "step11-browser-mobile");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("lost issue response replays exact action; hidden tab discards late private URL", async ({
  page,
}) => {
  await login(page);
  page.on("dialog", (dialog) => void dialog.accept());
  await page.getByRole("checkbox", { name: "Cedar Foxes" }).check();
  const requests: string[] = [];
  let drop = true;
  await page.route("**/createCalendarSubscription", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    requests.push(route.request().postData()!);
    const response = await route.fetch();
    if (drop) {
      drop = false;
      await route.abort("failed");
    } else await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Create private URL" }).click();
  await expect(
    page.getByRole("button", { name: "Retry same action" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText(
    "The result is uncertain. Retry the same action before making another change.",
  );
  await capture(page, "step11-browser-retry");
  await page.getByRole("button", { name: "Retry same action" }).click();
  await expect(
    page.getByText(
      "This action already completed. Rotate the subscription to obtain a new URL.",
    ),
  ).toBeVisible();
  expect(requests.length).toBeGreaterThanOrEqual(2);
  expect(new Set(requests).size).toBe(1);
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  await page.route("**/rotateCalendarSubscription", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Rotate URL" }).click();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  release();
  await expect(
    page.getByRole("heading", { name: "Subscription 1", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Subscription URL")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await login(page, "ui-outsider");
  await expect(page.getByText("No active subscriptions.")).toBeVisible();
  await expect(
    page.getByText("No eligible teams.", { exact: false }),
  ).toBeVisible();
  await capture(page, "step11-browser-no-access");
});

test("discovery fanout failure does not block owner removal", async ({
  page,
}) => {
  await login(page);
  page.on("dialog", (dialog) => void dialog.accept());
  await expect(
    page.getByRole("heading", { name: "Subscription 1", exact: true }),
  ).toBeVisible();
  const refs = Array.from({ length: 101 }, (_v, i) =>
    db.doc(`teamMembers/calendar-overflow-${i}_ui-parent`),
  );
  const batch = db.batch();
  for (const [i, ref] of refs.entries())
    batch.set(ref, {
      schemaVersion: 2,
      teamId: `calendar-overflow-${i}`,
      userId: "ui-parent",
      status: "active",
      roles: ["coach"],
    });
  await batch.commit();
  try {
    await page.getByRole("button", { name: "Reload subscriptions" }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Unable to load team choices. Saved subscriptions can still be removed.",
    );
    await expect(
      page.getByRole("button", { name: "Remove subscription" }),
    ).toBeEnabled();
    await capture(page, "step11-browser-discovery-failed");
    await page.getByRole("button", { name: "Remove subscription" }).click();
    await expect(page.getByText("No active subscriptions.")).toBeVisible();
  } finally {
    const cleanup = db.batch();
    for (const ref of refs) cleanup.delete(ref);
    await cleanup.commit();
  }
});
