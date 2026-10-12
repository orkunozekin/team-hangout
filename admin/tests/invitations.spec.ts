import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { createDecipheriv } from "node:crypto";
import { mkdir } from "node:fs/promises";
// @ts-ignore Shared synthetic fixture.
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
const { getAuth } = require("firebase-admin/auth");
if (process.env.ADMIN_EMULATOR_TESTS !== "1")
  throw new Error("Run through test:admin.");
test.describe.configure({ mode: "serial" });
async function capture(page: Page, name: string) {
  if (!process.env.ADMIN_EVIDENCE_DIR) return;
  await mkdir(process.env.ADMIN_EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: `${process.env.ADMIN_EVIDENCE_DIR}/${name}.png`,
    fullPage: true,
  });
}
async function signIn(page: Page, uid: string) {
  await page.getByLabel("Email address").fill(`${uid}@example.test`);
  await page.getByLabel("Password", { exact: true }).fill(demoPassword);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByText(`${uid}@example.test`, { exact: true }),
  ).toBeVisible();
}
async function token(email: string) {
  const app = initializeApp(
    { projectId: "demo-team-hangout" },
    `invitation-read-${Date.now()}`,
  );
  try {
    const docs = await getFirestore(app)
      .collection("emailOutbox")
      .where("recipientEmail", "==", email)
      .get();
    const row = docs.docs
      .map((d: any) => d.data())
      .find((r: any) => r.status === "queued");
    const p = row.payload;
    const c = createDecipheriv(
      "aes-256-gcm",
      Buffer.from("11".repeat(32), "hex"),
      Buffer.from(p.iv, "base64"),
    );
    c.setAuthTag(Buffer.from(p.tag, "base64"));
    return Buffer.concat([
      c.update(Buffer.from(p.ciphertext, "base64")),
      c.final(),
    ]).toString();
  } finally {
    await deleteApp(app);
  }
}
let acceptanceToken: string;
test.beforeAll(async () => {
  await seedHouseholdDemo();
  const app = initializeApp(
    { projectId: "demo-team-hangout" },
    "invitation-browser-setup",
  );
  try {
    await getFirestore(app).doc(`organizations/${householdOrg}/participants/invite-adult-demo`).set({ schemaVersion: 2, orgId: householdOrg, kind: "adult", displayName: "Synthetic Adult", status: "active", revision: 1, linkedUserId: null });
    for (const uid of ["ui-admin", "ui-outsider"])
      await getAuth(app).updateUser(uid, { emailVerified: true });
  } finally {
    await deleteApp(app);
  }
});
test("admin queues, rotates and revokes an invitation with clear delivery status", async ({
  page,
}) => {
  await page.goto(`/organizations/${householdOrg}/invitation`);
  await signIn(page, "ui-admin");
  await expect(page.getByText("No invitations yet.")).toBeVisible();
  await capture(page, "step9-browser-empty");
  await page
    .getByRole("combobox", { name: "Participant", exact: true })
    .selectOption("child-a");
  await page.getByLabel("Recipient email").fill("ui-outsider@example.test");
  await page
    .getByRole("button", { name: "Queue invitation", exact: true })
    .click();
  await expect(
    page.getByRole("cell", { name: "queued", exact: true }),
  ).toBeVisible();
  const old = await token("ui-outsider@example.test");
  await page
    .getByRole("button", { name: "Resend with new link", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Resend with new link", exact: true }),
  ).toBeEnabled();
  await expect.poll(() => token("ui-outsider@example.test")).not.toBe(old);
  await page
    .getByRole("button", { name: "Revoke invitation", exact: true })
    .click();
  await expect(
    page.getByRole("cell", { name: "revoked", exact: true }),
  ).toBeVisible();
  await capture(page, "step9-browser-revoked");
  await page
    .getByRole("combobox", { name: "Participant", exact: true })
    .selectOption("child-b");
  await page.getByLabel("Recipient email").fill("ui-outsider@example.test");
  await page
    .getByRole("button", { name: "Queue invitation", exact: true })
    .click();
  await expect(
    page.getByRole("cell", { name: "pending", exact: true }),
  ).toBeVisible();
  await capture(page, "step9-browser-queued");
  acceptanceToken = await token("ui-outsider@example.test");
  await page.getByRole("combobox", {name:"Relationship",exact:true}).selectOption("self");
  await page.getByRole("combobox", {name:"Participant",exact:true}).selectOption("invite-adult-demo");
  await expect(page.getByText("Approved access: view your profile and schedule, and edit your contact details. No response rights.")).toBeVisible();
  await capture(page,"step9-browser-self-rights");
});
test("link survives login, requires confirmation, clears on logout and accepts only intended email", async ({
  page,
}) => {
  await page.goto(`/invitation#token=${acceptanceToken}`);
  await expect(page).toHaveURL(/\/invitation$/);
  await expect(
    page.getByText("Sign in to review your invitation.", { exact: false }),
  ).toBeVisible();
  await signIn(page, "ui-admin");
  await expect(
    page.getByText("This invitation is for another email address.", {
      exact: false,
    }),
  ).toBeVisible();
  await capture(page, "step9-browser-wrong-email");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await signIn(page, "ui-outsider");
  await expect(
    page.getByRole("heading", { name: "Review your invitation" }),
  ).toBeHidden();
  await page.goto(`/invitation#token=${acceptanceToken}`);
  await expect(
    page.getByRole("heading", { name: "Casey Rivera" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm and accept invitation" }),
  ).toBeVisible();
  await capture(page, "step9-browser-confirm");
  await page
    .getByRole("button", { name: "Confirm and accept invitation" })
    .click();
  await expect(
    page.getByText(
      "Invitation accepted. Open your household to check current access.",
    ),
  ).toBeVisible();
  await capture(page, "step9-browser-accepted");
});

test("new household account verifies email before confirmation and uses no native installation", async ({
  page,
}) => {
  const email = `invitation-new-${Date.now()}@example.test`;
  await page.goto(`/organizations/${householdOrg}/participant`);
  await signIn(page, "ui-admin");
  await expect(page.getByRole("link", {name:"Manage invitations",exact:true})).toBeVisible();
  await capture(page, "step9-browser-participant-entry");
  await page.getByRole("link", {name:"Manage invitations",exact:true}).click();
  await page
    .getByRole("combobox", { name: "Participant", exact: true })
    .selectOption("child-a");
  await page.getByLabel("Recipient email").fill(email);
  await page
    .getByRole("button", { name: "Queue invitation", exact: true })
    .click();
  await expect(
    page.getByRole("cell", { name: email, exact: true }),
  ).toBeVisible();
  const raw = await token(email);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await page.goto(`/invitation#token=${raw}`);
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(demoPassword);
  await page
    .getByRole("button", { name: "Create household account", exact: true })
    .click();
  await expect(
    page.getByText("Verify your email address before accepting.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Confirm and accept invitation" }),
  ).toBeHidden();
  await capture(page, "step9-browser-verify-email");
  const app = initializeApp(
    { projectId: "demo-team-hangout" },
    "invitation-verify-new",
  );
  try {
    const user = await getAuth(app).getUserByEmail(email);
    await getAuth(app).updateUser(user.uid, { emailVerified: true });
  } finally {
    await deleteApp(app);
  }
  await page
    .getByRole("button", { name: "Check invitation again", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Jamie Rivera", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Confirm and accept invitation" })
    .click();
  await expect(
    page.getByText(
      "Invitation accepted. Open your household to check current access.",
    ),
  ).toBeVisible();
});
