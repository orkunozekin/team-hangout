import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
// @ts-ignore Synthetic emulator fixture shared with native evidence sessions.
import {
  seedHouseholdDemo,
  householdOrg,
  demoPassword,
} from "../../scripts/seed-household-demo.mjs";
const require = createRequire(
  new URL("../../functions/package.json", import.meta.url),
);
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
if (process.env.ADMIN_EMULATOR_TESTS !== "1")
  throw new Error("Run through test:admin.");
test.describe.configure({ mode: "serial" });
async function open(page: Page, uid = "ui-admin", query = "") {
  await page.goto(`/organizations/${householdOrg}/participant${query}`);
  await page.getByLabel("Email address").fill(`${uid}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill(demoPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Participants and rosters",
      exact: true,
    }),
  ).toBeVisible();
}
async function capture(page: Page, name: string) {
  const dir = process.env.ADMIN_EVIDENCE_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}
test.beforeAll(async () => {
  await seedHouseholdDemo();
});
test("administrator creates participant, edits private profile, removes and restores enrollment", async ({
  page,
}) => {
  await open(page);
  await page
    .getByRole("combobox", { name: "Team", exact: true })
    .selectOption("ui-empty-team");
  await expect(page.getByText("No enrolled participants.")).toBeVisible();
  await capture(page, "step8-browser-empty");
  await page
    .getByRole("combobox", { name: "Team", exact: true })
    .selectOption("ui-team");
  await expect(
    page.getByRole("cell", { name: "Jamie Rivera", exact: true }),
  ).toBeVisible();
  await capture(page, "step8-browser-roster");
  const jamie = page.getByRole("row").filter({
    has: page.getByRole("cell", { name: "Jamie Rivera", exact: true }),
  });
  await jamie.getByLabel("Enrollment status").selectOption("removed");
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/listRoster") && r.request().method() === "POST",
    ),
    jamie.getByRole("button").click(),
  ]);
  await expect(jamie.getByLabel("Enrollment status")).toHaveValue("removed");
  await jamie.getByLabel("Enrollment status").selectOption("active");
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith("/listRoster") && r.request().method() === "POST",
    ),
    jamie.getByRole("button").click(),
  ]);
  await expect(jamie.getByLabel("Enrollment status")).toHaveValue("active");
  await page
    .getByRole("button", { name: "Manage Jamie Rivera", exact: true })
    .click();
  await expect(page.getByLabel("Staff notes")).toHaveValue(
    "STAFF PRIVATE DEMO NOTE",
  );
  await expect(page.getByText("Alex Rivera · ui-parent")).toBeVisible();
  const recheck = page.waitForResponse(
    (r) =>
      r.url().endsWith("/getAdminWorkspace") && r.request().method() === "POST",
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await recheck;
  await expect(page.getByLabel("Staff notes")).toHaveValue(
    "STAFF PRIVATE DEMO NOTE",
  );
  await capture(page, "step8-browser-admin-profile");
  await page.getByLabel("Participant phone").fill("555-0200");
  await page
    .getByRole("button", { name: "Save private profile", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Close participant" }),
  ).toBeHidden();
  await page
    .getByRole("button", { name: "New participant", exact: true })
    .click();
  await page
    .getByLabel("Participant name", { exact: true })
    .fill("Jordan Demo");
  await page
    .getByRole("button", { name: "Save participant", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Jordan Demo", exact: true }),
  ).toBeVisible();
});
test("program staff sees roster display fields and revoked scope discards editor and roster", async ({
  page,
}) => {
  await open(page, "ui-staff", "?program=soccer");
  await page
    .getByRole("combobox", { name: "Team", exact: true })
    .selectOption("ui-team");
  await expect(
    page.getByRole("cell", { name: "Jamie Rivera", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Organization participants", { exact: true }),
  ).toBeHidden();
  await expect(page.getByLabel("Staff notes")).toBeHidden();
  const payload = await page.evaluate(async () => {
    const requests = performance
      .getEntriesByType("resource")
      .filter((r) => r.name.endsWith("/listRoster"));
    return requests.length;
  });
  expect(payload).toBeGreaterThan(0);
  await capture(page, "step8-browser-staff-roster");
  const app = initializeApp(
    { projectId: "demo-team-hangout" },
    "step8-browser-revoke",
  );
  try {
    await getFirestore(app)
      .doc(`organizations/${householdOrg}/members/ui-staff`)
      .update({ status: "revoked" });
  } finally {
    await deleteApp(app);
  }
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByRole("heading", { name: "Participant access unavailable" }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Jamie Rivera", exact: true }),
  ).toBeHidden();
  await capture(page, "step8-browser-permission-removed");
});
