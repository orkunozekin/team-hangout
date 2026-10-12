import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createDecipheriv, randomBytes } from "node:crypto";
import { initializeApp, deleteApp } from "firebase/app";
import {
  getAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
} from "firebase/auth";
import {
  getFunctions,
  connectFunctionsEmulator,
  httpsCallable,
} from "firebase/functions";
import { projectId, requireEmulators } from "./fixtures.mjs";
requireEmulators();
const require = createRequire(
  new URL("../../functions/package.json", import.meta.url),
);
const {
  initializeApp: adminApp,
  deleteApp: deleteAdmin,
} = require("firebase-admin/app");
const { getAuth: adminAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
let admin, db;
const apps = {};
let n = 0;
const orgId = "invite-org";
const permissions = {
  viewSchedule: true,
  viewProfile: true,
  editProfile: false,
  respond: false,
};
const req = (payload) => ({ requestId: `invite-action-${++n}`, ...payload });
const call = async (uid, name, data) =>
  (await httpsCallable(getFunctions(apps[uid]), name)(data)).data;
const deny = (promise) =>
  assert.rejects(promise, { code: "functions/permission-denied" });
function decrypt(payload) {
  const c = createDecipheriv(
    "aes-256-gcm",
    Buffer.from("11".repeat(32), "hex"),
    Buffer.from(payload.iv, "base64"),
  );
  c.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([
    c.update(Buffer.from(payload.ciphertext, "base64")),
    c.final(),
  ]).toString();
}
async function raw(invitation) {
  const row = (
    await db.doc(`organizations/${orgId}/invitations/${invitation.id}`).get()
  ).data();
  return decrypt(
    (await db.doc(`emailOutbox/${row.outboxId}`).get()).data().payload,
  );
}
async function create(extra = {}) {
  const participantId = `invite-child-${++n}`;
  await db
    .doc(`organizations/${orgId}/participants/${participantId}`)
    .set({
      schemaVersion: 2,
      orgId,
      kind: "youth",
      status: "active",
      revision: 1,
      linkedUserId: null,
      displayName: "Synthetic child",
    });
  return (
    await call(
      "invite-admin",
      "createInvitation",
      req({
        orgId,
        participantId,
        recipientEmail: "invite-parent@example.test",
        relationship: "guardian",
        permissions,
        ...extra,
      }),
    )
  ).invitation;
}
const inspect = (token) =>
  call("invite-parent", "inspectInvitation", { token });
const accept = (token) =>
  call("invite-parent", "acceptInvitation", { token, confirmed: true });
before(async () => {
  admin = adminApp({ projectId });
  db = getFirestore(admin);
  for (const uid of [
    "invite-admin",
    "invite-parent",
    "invite-wrong",
    "invite-unverified",
    "invite-staff",
    "invite-outsider",
  ]) {
    const app = initializeApp({ projectId, apiKey: "demo-key" }, uid);
    apps[uid] = app;
    connectAuthEmulator(getAuth(app), "http://127.0.0.1:9099", {
      disableWarnings: true,
    });
    connectFunctionsEmulator(getFunctions(app), "127.0.0.1", 5001);
    await adminAuth(admin).createUser({
      uid,
      email: `${uid}@example.test`,
      password: "SyntheticPassword123!",
      emailVerified: uid !== "invite-unverified",
    });
    await db.doc(`users/${uid}`).set({ uid, appRole: "user" });
    await signInWithEmailAndPassword(
      getAuth(app),
      `${uid}@example.test`,
      "SyntheticPassword123!",
    );
  }
  await db
    .doc(`organizations/${orgId}`)
    .set({
      schemaVersion: 2,
      status: "active",
      features: {
        organizationV2: true,
        households: true,
        guardianProfileEditing: true,
      },
    });
  for (const [uid, roles] of [
    ["invite-admin", ["orgAdmin"]],
    ["invite-staff", ["programStaff"]],
  ])
    await db
      .doc(`organizations/${orgId}/members/${uid}`)
      .set({ orgId, roles, programIds: ["program"], status: "active" });
});
after(async () => {
  await Promise.all(Object.values(apps).map(deleteApp));
  await deleteAdmin(admin);
});
test("issue stores hash-only index, encrypted queued delivery, seven-day expiry and safe receipt", async () => {
  const i = await create({ recipientEmail: "  INVITE-PARENT@EXAMPLE.TEST " });
  const token = await raw(i);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(i.recipientEmail, "invite-parent@example.test");
  assert.equal(i.deliveryStatus, "queued");
  assert.ok(
    Math.abs(Date.parse(i.expiresAt) - Date.now() - 7 * 86400000) < 60000,
  );
  const row = (
    await db.doc(`organizations/${orgId}/invitations/${i.id}`).get()
  ).data();
  assert.match(row.tokenHash, /^[a-f0-9]{64}$/);
  const receipts = await db
    .collection("commandRequests")
    .where("uid", "==", "invite-admin")
    .get();
  for (const receipt of receipts.docs)
    assert.ok(!JSON.stringify(receipt.data()).includes(token));
  assert.ok(!JSON.stringify(row).includes(token));
  assert.equal((await inspect(token)).participantName, "Synthetic child");
});
test("wrong email, unverified email and missing confirmation cannot create access", async () => {
  const i = await create();
  const token = await raw(i);
  assert.equal(
    (await call("invite-wrong", "inspectInvitation", { token })).status,
    "wrong-email",
  );
  assert.equal(
    (await call("invite-wrong", "acceptInvitation", { token, confirmed: true }))
      .status,
    "wrong-email",
  );
  const unverified = await create({
    recipientEmail: "invite-unverified@example.test",
  });
  const ut = await raw(unverified);
  assert.equal(
    (
      await call("invite-unverified", "acceptInvitation", {
        token: ut,
        confirmed: true,
      })
    ).status,
    "verify-email",
  );
  await assert.rejects(
    call("invite-parent", "acceptInvitation", { token, confirmed: false }),
    { code: "functions/invalid-argument" },
  );
  assert.equal(
    (
      await db
        .doc(
          `organizations/${orgId}/participants/${i.participantId}/guardians/invite-wrong`,
        )
        .get()
    ).exists,
    false,
  );
});
test("concurrent accept/replay makes exactly one relationship and never restores revoked access", async () => {
  const i = await create();
  const token = await raw(i);
  const results = await Promise.all([
    accept(token),
    accept(token),
    accept(token),
  ]);
  assert.ok(results.every((r) => r.status === "accepted"));
  const ref = db.doc(`organizations/${orgId}/participants/${i.participantId}`);
  assert.equal((await ref.get()).data().revision, 2);
  const grant = ref.collection("guardians").doc("invite-parent");
  assert.equal((await grant.get()).data().revision, 1);
  assert.ok(
    (await call("invite-parent", "listMyParticipants", {})).items.some(
      (p) => p.id === i.participantId,
    ),
  );
  await call(
    "invite-admin",
    "revokeGuardian",
    req({
      orgId,
      participantId: i.participantId,
      userId: "invite-parent",
      expectedRevision: 2,
    }),
  );
  assert.equal((await accept(token)).status, "accepted");
  assert.equal((await grant.get()).data().status, "revoked");
});
test("resend rotates and cancels old delivery; repeated action issues no duplicate", async () => {
  const i = await create();
  const old = await raw(i);
  const payload = req({
    orgId,
    invitationId: i.id,
    expectedRevision: i.revision,
  });
  const result = await call("invite-admin", "resendInvitation", payload);
  const next = await raw(result.invitation);
  assert.notEqual(next, old);
  assert.equal((await inspect(old)).status, "replaced");
  assert.deepEqual(
    await call("invite-admin", "resendInvitation", payload),
    result,
  );
  assert.equal((await inspect(next)).status, "pending");
  await assert.rejects(
    call(
      "invite-admin",
      "resendInvitation",
      req({ orgId, invitationId: i.id, expectedRevision: 1 }),
    ),
    { code: "functions/aborted" },
  );
});
test("revoked and expired tokens fail safely, including concurrent revoke/accept", async () => {
  const i = await create();
  const token = await raw(i);
  await call(
    "invite-admin",
    "revokeInvitation",
    req({ orgId, invitationId: i.id, expectedRevision: i.revision }),
  );
  assert.equal((await accept(token)).status, "revoked");
  const expired = await create();
  const et = await raw(expired);
  await db
    .doc(`organizations/${orgId}/invitations/${expired.id}`)
    .update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
  assert.equal((await inspect(et)).status, "expired");
  assert.equal((await accept(et)).status, "expired");
  const race = await create();
  const rt = await raw(race);
  await Promise.allSettled([
    accept(rt),
    call(
      "invite-admin",
      "revokeInvitation",
      req({ orgId, invitationId: race.id, expectedRevision: race.revision }),
    ),
  ]);
  const row = (
    await db.doc(`organizations/${orgId}/invitations/${race.id}`).get()
  ).data();
  const grant = await db
    .doc(
      `organizations/${orgId}/participants/${race.participantId}/guardians/invite-parent`,
    )
    .get();
  assert.equal(grant.exists, row.status === "accepted");
});
test("canonical staff scope, tenant, archive, rollout and target-kind checks are enforced", async () => {
  const i = await create();
  const token = await raw(i);
  for (const uid of ["invite-staff", "invite-outsider", "invite-parent"])
    await deny(call(uid, "listInvitations", { orgId }));
  await deny(
    call(
      "invite-admin",
      "createInvitation",
      req({
        orgId: "other-org",
        participantId: i.participantId,
        recipientEmail: "invite-parent@example.test",
        relationship: "guardian",
        permissions,
      }),
    ),
  );
  await assert.rejects(create({ relationship: "self" }), {
    code: "functions/invalid-argument",
  });
  await db
    .doc(`organizations/${orgId}/members/invite-admin`)
    .update({ status: "revoked" });
  await deny(accept(token));
  await db
    .doc(`organizations/${orgId}/members/invite-admin`)
    .update({ status: "active" });
  await db
    .doc(`organizations/${orgId}`)
    .update({ "features.households": false });
  await deny(accept(token));
  await call(
    "invite-admin",
    "revokeInvitation",
    req({ orgId, invitationId: i.id, expectedRevision: i.revision }),
  );
  await db
    .doc(`organizations/${orgId}`)
    .update({ "features.households": true });
});
test("adult self acceptance links explicitly; existing guardian rights cannot be silently overwritten", async () => {
  const participantId = `invite-adult-${++n}`;
  await db
    .doc(`organizations/${orgId}/participants/${participantId}`)
    .set({
      schemaVersion: 2,
      orgId,
      kind: "adult",
      status: "active",
      revision: 1,
      linkedUserId: null,
      displayName: "Synthetic adult",
    });
  const i = await create({ participantId, relationship: "self" });
  assert.equal(i.permissions.editProfile, true);
  await accept(await raw(i));
  assert.equal(
    (
      await db.doc(`organizations/${orgId}/participants/${participantId}`).get()
    ).data().linkedUserId,
    "invite-parent",
  );
  const child = await create();
  const ct = await raw(child);
  await call(
    "invite-admin",
    "approveGuardian",
    req({
      orgId,
      participantId: child.participantId,
      userId: "invite-parent",
      expectedRevision: 1,
      permissions: { ...permissions, viewProfile: false },
    }),
  );
  await assert.rejects(accept(ct), { code: "functions/failed-precondition" });
});
test("deleting recipient or inviter denies cached-token acceptance; cleanup removes nested invitation tokens", async () => {
  const i = await create();
  const token = await raw(i);
  await db.doc("users/invite-parent").update({ accountState: "deleting" });
  await deny(accept(token));
  await db.doc("users/invite-parent").update({ accountState: "active" });
  await db.doc("users/invite-admin").update({ accountState: "deleting" });
  await deny(accept(token));
  await db.doc("users/invite-admin").update({ accountState: "active" });
  const {
    beginDeletion,
    resumeDeletion,
  } = require("./lib/accounts/deletion.js");
  const row = (
    await db.doc(`organizations/${orgId}/invitations/${i.id}`).get()
  ).data();
  await beginDeletion("invite-parent");
  await resumeDeletion("invite-parent", 100, { deleteUser: async () => {} });
  assert.equal(
    (await db.doc(`organizations/${orgId}/invitations/${i.id}`).get()).exists,
    false,
  );
  assert.equal(
    (await db.doc(`invitationTokens/${row.tokenHash}`).get()).exists,
    false,
  );
});
