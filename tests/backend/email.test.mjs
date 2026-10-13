import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { projectId, requireEmulators } from "./fixtures.mjs";
requireEmulators();
const require = createRequire(
  new URL("../../functions/package.json", import.meta.url),
);
const { initializeApp, deleteApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
// Direct worker tests use the same explicit demo identity as Functions emulator. No live transport is constructed.
process.env.FUNCTIONS_EMULATOR = "true";
const { processOutbox } = require("./lib/email/worker.js");
const {
  developmentTransport,
  DeliveryFailure,
  contactKey,
  senderConfig,
  productionTransport,
} = require("./lib/email/transport.js");
const { recordDeliveryOutcome } = require("./lib/email/outcomes.js");
const { eventInformation } = require("./lib/email/access.js");
let app,
  db,
  n = 0;
const orgId = "email-org";
const meta = { schemaVersion: 2, status: "active", revision: 1, orgId };
const uid = "email-parent",
  other = "email-second-parent";
const config = {
  from: "demo@example.test",
  replyTo: "help@example.test",
  browserOrigin: "http://127.0.0.1:4177",
  privacyPolicyUrl: "http://127.0.0.1:4177/help",
};
const email = (id) => `${id}@example.test`;
async function queue(recipientUid = uid) {
  const key = `email-${++n}`;
  await db.doc(`emailOutbox/${key}`).set({
    kind: "publishedEvent",
    orgId,
    eventId: "email-event",
    eventRevision: 1,
    recipientUid,
    recipientEmail: email(recipientUid),
    status: "queued",
    attemptCount: 0,
    nextAttemptAt: Timestamp.now(),
  });
  return key;
}
const row = async (key) => (await db.doc(`emailOutbox/${key}`).get()).data();
async function invitation() {
  const key = `invitation-${++n}`,
    raw = randomBytes(32).toString("base64url"),
    tokenHash = createHash("sha256").update(raw).digest("hex"),
    iv = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      Buffer.from("11".repeat(32), "hex"),
      iv,
    );
  const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
  await db.doc(`organizations/${orgId}/invitations/${key}`).set({
    ...meta,
    status: "pending",
    outboxId: key,
    tokenHash,
    invitedBy: "email-admin",
    recipientEmail: email(uid),
    participantId: "email-child",
    participantAccessRevision: 0,
    relationship: "guardian",
    permissions: { viewSchedule: true, viewProfile: true },
    teamId: "email-team",
    expiresAt: Timestamp.fromMillis(Date.now() + 86400000),
  });
  await db
    .doc(`invitationTokens/${tokenHash}`)
    .set({ status: "active", orgId, invitationId: key });
  await db.doc(`emailOutbox/${key}`).set({
    kind: "invitation",
    invitationId: key,
    invitationRevision: 1,
    orgId,
    recipientUid: uid,
    recipientEmail: email(uid),
    status: "queued",
    payload: {
      version: 1,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    },
  });
  return { key, raw };
}
before(async () => {
  app = initializeApp({ projectId });
  db = getFirestore(app);
  for (const id of [uid, other, "email-outsider", "email-admin"]) {
    await getAuth().createUser({
      uid: id,
      email: email(id),
      emailVerified: true,
    });
    await db.doc(`users/${id}`).set({ uid: id, appRole: "user" });
  }
  await db.doc(`organizations/${orgId}`).set({
    ...meta,
    name: "Cedar Park Athletics",
    features: { organizationV2: true, households: true, essentialEmail: true },
  });
  await db
    .doc(`organizations/${orgId}/members/email-admin`)
    .set({ ...meta, roles: ["orgAdmin"], programIds: [] });
  await db.doc(`organizations/${orgId}/programs/email-program`).set(meta);
  await db
    .doc(`organizations/${orgId}/seasons/email-season`)
    .set({ ...meta, programId: "email-program" });
  await db
    .doc(`organizations/${orgId}/divisions/email-division`)
    .set({ ...meta, programId: "email-program", seasonId: "email-season" });
  await db.doc("teams/email-team").set({
    ...meta,
    name: "Falcons",
    programId: "email-program",
    seasonId: "email-season",
    divisionId: "email-division",
  });
  await db.doc(`organizations/${orgId}/participants/email-child`).set({
    ...meta,
    displayName: "Private child",
    linkedUserId: null,
    kind: "youth",
  });
  for (const id of [uid, other])
    await db
      .doc(`organizations/${orgId}/participants/email-child/guardians/${id}`)
      .set({
        ...meta,
        userId: id,
        participantId: "email-child",
        permissions: { viewSchedule: true },
      });
  await db
    .doc("teams/email-team/roster/email-child")
    .set({ ...meta, participantId: "email-child" });
  await db.doc("events/email-event").set({
    ...meta,
    programId: "email-program",
    seasonId: "email-season",
    divisionId: "email-division",
    teamId: "email-team",
    teamIds: ["email-team"],
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
});
after(async () => deleteApp(app));
test("mailbox proves two separate guardians, safe time/place and private/help fallbacks, without child names", async () => {
  const keys = [
    await queue(),
    await queue(other),
    await queue("email-outsider"),
  ];
  assert.deepEqual(await Promise.all(keys.map((key) => processOutbox(key))), [
    "sent",
    "sent",
    "cancelled",
  ]);
  for (let i = 0; i < 2; i++) {
    const mail = (await db.doc(`developmentMailbox/${keys[i]}`).get()).data();
    assert.equal(mail.to, email(i ? other : uid));
    for (const value of [
      "Falcons",
      "5:00 PM",
      "America/Chicago",
      "Cedar Park field",
      "/events/email-event",
      "/help",
      "/email-preferences",
    ])
      assert.ok(mail.text.includes(value), value);
    assert.ok(!mail.text.includes("Private child"));
    assert.ok(!mail.text.includes(email(i ? uid : other)));
  }
});
test("invitation mail contains only its encrypted grant link and never creates a grant", async () => {
  const { key, raw } = await invitation();
  assert.equal(await processOutbox(key), "sent");
  const mail = (await db.doc(`developmentMailbox/${key}`).get()).data();
  assert.ok(mail.text.includes(`/invitation#token=${raw}`));
  assert.ok(mail.text.includes("Team: Falcons"));
  assert.ok(mail.text.includes("Time/place:"));
  assert.ok(!mail.text.includes("Private child"));
  assert.equal((await row(key)).payload, null);
  assert.equal(
    (await db.doc(`organizations/${orgId}/invitations/${key}`).get()).data()
      .status,
    "pending",
  );
});
test("pre-send failures use bounded retries, concurrent lease prevents duplicates and stale leases terminate ambiguously", async () => {
  const key = await queue();
  const fail = {
    send: async () => {
      throw new DeliveryFailure("PRE_SEND");
    },
  };
  assert.equal(await processOutbox(key, { transport: fail }), "pending");
  assert.equal(await processOutbox(key), "skipped");
  await db
    .doc(`emailOutbox/${key}`)
    .update({ nextAttemptAt: Timestamp.fromMillis(0) });
  assert.deepEqual(
    (await Promise.all([processOutbox(key), processOutbox(key)])).sort(),
    ["sent", "skipped"],
  );
  assert.equal((await row(key)).attemptCount, 2);
  const terminal = await queue();
  for (let i = 0; i < 5; i++) {
    await db
      .doc(`emailOutbox/${terminal}`)
      .update({ nextAttemptAt: Timestamp.fromMillis(0) });
    await processOutbox(terminal, { transport: fail });
  }
  assert.equal((await row(terminal)).status, "failed");
  assert.equal((await row(terminal)).attemptCount, 5);
  const crashed = await queue();
  await db.doc(`emailOutbox/${crashed}`).update({
    status: "sending",
    lease: "lost",
    leaseUntil: Timestamp.fromMillis(0),
  });
  assert.equal(await processOutbox(crashed), "skipped");
  assert.equal((await row(crashed)).failureCode, "AMBIGUOUS");
});
test("post-send ambiguity, including unclassified adapter errors, never blindly retries accepted mail", async () => {
  for (const failure of [
    new DeliveryFailure("AMBIGUOUS"),
    new Error("unknown provider result"),
  ]) {
    const key = await queue();
    const sink = developmentTransport();
    assert.equal(
      await processOutbox(key, {
        transport: {
          send: async (k, m) => {
            await sink.send(k, m);
            throw failure;
          },
        },
      }),
      "failed",
    );
    assert.equal((await row(key)).failureCode, "AMBIGUOUS");
    assert.equal(await processOutbox(key), "skipped");
    assert.ok((await db.doc(`developmentMailbox/${key}`).get()).exists);
  }
});
test("final check drops revoked grants, changed event revisions, deleting accounts and revoked/rotated/stale invitations", async () => {
  const key = await queue();
  assert.equal(
    await processOutbox(key, {
      beforeSend: async () =>
        db
          .doc(
            `organizations/${orgId}/participants/email-child/guardians/${uid}`,
          )
          .update({ status: "revoked" }),
    }),
    "cancelled",
  );
  await assert.rejects(
    db.runTransaction((tx) => eventInformation(tx, "email-event", uid)),
    { code: "permission-denied" },
  );
  await db
    .doc(`organizations/${orgId}/participants/email-child/guardians/${uid}`)
    .update({ status: "active" });
  const stale = await queue();
  await db.doc("events/email-event").update({ revision: 2 });
  assert.equal(await processOutbox(stale), "cancelled");
  await db.doc("events/email-event").update({ revision: 1 });
  const deleting = await queue();
  await db.doc(`users/${uid}`).update({ accountState: "deleting" });
  assert.equal(await processOutbox(deleting), "cancelled");
  await db.doc(`users/${uid}`).update({ accountState: "active" });
  for (const patch of [
    { status: "revoked" },
    { outboxId: "replacement" },
    { participantAccessRevision: 99 },
  ]) {
    const { key: i } = await invitation();
    await db.doc(`organizations/${orgId}/invitations/${i}`).update(patch);
    assert.equal(await processOutbox(i), "cancelled");
    assert.ok(!(await db.doc(`developmentMailbox/${i}`).get()).exists);
  }
});
test("suppression preference and verified contact changes prevent sends; correlated bounce suppresses future mail", async () => {
  await db
    .doc(`users/${uid}/communication/essential`)
    .set({ suppressed: true });
  assert.equal(await processOutbox(await queue()), "cancelled");
  await db.doc(`users/${uid}/communication/essential`).delete();
  for (const patch of [
    { emailVerified: false },
    { email: "changed@example.test" },
    { disabled: true },
  ]) {
    await getAuth().updateUser(uid, patch);
    assert.equal(await processOutbox(await queue()), "cancelled");
    await getAuth().updateUser(uid, {
      emailVerified: true,
      email: email(uid),
      disabled: false,
    });
  }
  const key = await queue();
  assert.equal(await processOutbox(key), "sent");
  assert.equal(await recordDeliveryOutcome(key, "wrong-id", "bounce"), false);
  assert.equal(
    await recordDeliveryOutcome(
      key,
      (await row(key)).transportMessageId,
      "bounce",
    ),
    true,
  );
  assert.equal((await row(key)).failureCode, "BOUNCE");
  assert.ok(
    (
      await db.doc(`emailSuppressions/${contactKey(orgId, email(uid))}`).get()
    ).data().suppressed,
  );
  assert.equal(await processOutbox(await queue()), "cancelled");
  await db.doc(`emailSuppressions/${contactKey(orgId, email(uid))}`).delete();
});
test("production sender gate is closed by default and adapter sanitizes results without live requests", async () => {
  process.env.FUNCTIONS_EMULATOR = "false";
  assert.equal(senderConfig(), null);
  assert.equal(await processOutbox(await queue()), "disabled");
  const original = globalThis.fetch;
  let request;
  try {
    globalThis.fetch = async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ id: "provider-123" }), {
        status: 200,
      });
    };
    assert.equal(
      await productionTransport(
        { ...config, browserOrigin: "https://example.test" },
        "synthetic-key",
      ).send("stable", { to: email(uid), subject: "Hello", text: "Private" }),
      "provider-123",
    );
    assert.equal(
      request.options.headers["Idempotency-Key"],
      "essential/stable",
    );
    assert.deepEqual(JSON.parse(request.options.body).to, [email(uid)]);
    globalThis.fetch = async () => {
      throw new Error("sensitive provider response");
    };
    await assert.rejects(
      productionTransport(config, "synthetic-key").send("stable", {
        to: email(uid),
        subject: "Hello",
        text: "Private",
      }),
      (e) => e.code === "AMBIGUOUS" && !e.message.includes("sensitive"),
    );
  } finally {
    globalThis.fetch = original;
    process.env.FUNCTIONS_EMULATOR = "true";
  }
});

test("organization rollout disabled preserves queued mail and bounce terminal failure is suppressed", async () => {
  const key = await queue();
  await db
    .doc(`organizations/${orgId}`)
    .update({ "features.essentialEmail": false });
  assert.equal(await processOutbox(key), "disabled");
  assert.equal((await row(key)).status, "queued");
  assert.equal((await row(key)).attemptCount, 0);
  await db
    .doc(`organizations/${orgId}`)
    .update({ "features.essentialEmail": true });
  assert.equal(
    await processOutbox(key, {
      transport: {
        send: async () => {
          throw new DeliveryFailure("BOUNCE");
        },
      },
    }),
    "failed",
  );
  assert.equal((await row(key)).failureCode, "BOUNCE");
  assert.equal(await processOutbox(await queue()), "cancelled");
  await db.doc(`emailSuppressions/${contactKey(orgId, email(uid))}`).delete();
});

test("private event response and staff summaries are scoped, denied to outsiders and unavailable for staged/deleted records", async () => {
  const privateEvent = await db.runTransaction((tx) =>
    eventInformation(tx, "email-event", uid),
  );
  assert.equal(privateEvent.title, "Evening practice");
  assert.ok(!JSON.stringify(privateEvent).includes("Private child"));
  await assert.rejects(
    db.runTransaction((tx) =>
      eventInformation(tx, "email-event", "email-outsider"),
    ),
    { code: "permission-denied" },
  );
  for (const patch of [
    { publicationState: "staged" },
    { deletedAt: Timestamp.now() },
    { publicationOperationId: "pending-operation" },
  ]) {
    await db.doc("events/email-event").update(patch);
    await assert.rejects(
      db.runTransaction((tx) => eventInformation(tx, "email-event", uid)),
      { code: "permission-denied" },
    );
    await db.doc("events/email-event").update({
      publicationState: "published",
      deletedAt: null,
      publicationOperationId: null,
    });
  }
  const { listEssentialEmail } = require("./lib/email/commands.js");
  const result = await listEssentialEmail.run({
    auth: { uid: "email-admin" },
    data: { orgId, pageSize: 2 },
  });
  assert.equal(result.items.length, 2);
  assert.ok(result.nextCursor);
  assert.ok(!JSON.stringify(result).includes("@example.test"));
  await assert.rejects(
    listEssentialEmail.run({ auth: { uid }, data: { orgId } }),
    { code: "permission-denied" },
  );
  await assert.rejects(
    listEssentialEmail.run({
      auth: { uid: "email-admin" },
      data: { orgId: "unrelated-org" },
    }),
    { code: "permission-denied" },
  );
});
test("lease expiration or cancellation during canonical preparation prevents dispatch", async () => {
  for (const patch of [
    { leaseUntil: Timestamp.fromMillis(0) },
    { status: "cancelled" },
  ]) {
    const key = await queue();
    assert.equal(
      await processOutbox(key, {
        afterPrepare: async () => db.doc(`emailOutbox/${key}`).update(patch),
      }),
      "skipped",
    );
    assert.equal(
      (await db.doc(`developmentMailbox/${key}`).get()).exists,
      false,
    );
  }
});

test("account deletion removes transactional preference and fences mail during cleanup", async () => {
  const {
    beginDeletion,
    resumeDeletion,
  } = require("./lib/accounts/deletion.js");
  await db
    .doc(`users/${other}/communication/essential`)
    .set({ suppressed: false });
  const key = await queue(other);
  await beginDeletion(other);
  assert.equal(await processOutbox(key), "cancelled");
  await resumeDeletion(other, 100, { deleteUser: async () => {} });
  assert.equal(
    (await db.doc(`users/${other}/communication/essential`).get()).exists,
    false,
  );
  assert.equal((await db.doc(`users/${other}`).get()).exists, false);
});
