import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
  FieldPath,
  getFirestore,
  Timestamp,
  Transaction,
} from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getAuth } from "firebase-admin/auth";
import { accountAvailable } from "../accountAccess";
import {
  command,
  Data,
  id,
  invalid,
  keys,
  object,
  revision,
  text,
  wire,
} from "../commandSupport";
import {
  adminScope,
  choice,
  metadata,
  page,
  participant,
  participantRef,
  prepareProjections,
  projectionSources,
  readCommand,
} from "../participants/policy";
import { audit } from "../organizations/commands";
import {
  checkRevision,
  denied,
  hierarchy,
  inactive,
} from "../organizations/policy";

const deliveryKey = defineSecret("INVITATION_DELIVERY_KEY");
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const invitationRef = (orgId: string, invitationId: string) =>
  getFirestore().doc(`organizations/${orgId}/invitations/${invitationId}`);
const tokenRef = (token: string) =>
  getFirestore().doc(`invitationTokens/${digest(token)}`);
function token(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))
    invalid("Invalid invitation link. Ask your organization for a new link.");
  return value as string;
}
function email(value: unknown) {
  const result = text(value, "recipientEmail", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result))
    invalid("Enter a valid recipient email.");
  return result;
}
function permissions(value: unknown) {
  const result = object(value);
  keys(result, ["viewSchedule", "viewProfile", "editProfile", "respond"]);
  for (const key of ["viewSchedule", "viewProfile", "editProfile", "respond"])
    if (typeof result[key] !== "boolean") invalid("Invalid permissions.");
  if (
    result.respond ||
    (result.editProfile && !result.viewProfile) ||
    (!result.viewProfile && !result.viewSchedule)
  )
    invalid("Invalid Phase 1 permissions.");
  return result;
}
function state(row: Data) {
  return row.status === "pending" && row.expiresAt.toMillis() <= Date.now()
    ? "expired"
    : row.status;
}
function publicRow(invitationId: string, row: Data): Data {
  return {
    id: invitationId,
    participantId: row.participantId,
    teamId: row.teamId,
    recipientEmail: row.recipientEmail,
    relationship: row.relationship,
    permissions: row.permissions,
    status: state(row),
    deliveryStatus: row.deliveryStatus,
    expiresAt: row.expiresAt,
    revision: row.revision,
  };
}
async function target(tx: Transaction, row: Data, writing = true) {
  const p = await participant(tx, row.orgId, row.participantId);
  if (writing && p.status !== "active") inactive();
  if (row.relationship === "self" && p.kind !== "adult")
    invalid("Only confirmed adults can link their own account.");
  if (row.teamId) {
    const team = (
      await tx.get(getFirestore().doc(`teams/${row.teamId}`))
    ).data();
    if (!team || team.schemaVersion !== 2 || team.orgId !== row.orgId) denied();
    await hierarchy(
      tx,
      row.orgId,
      team.programId,
      team.seasonId,
      team.divisionId,
      writing,
    );
    const enrollment = (
      await tx.get(
        getFirestore().doc(`teams/${row.teamId}/roster/${row.participantId}`),
      )
    ).data();
    if (
      writing &&
      (team.status !== "active" ||
        enrollment?.orgId !== row.orgId ||
        enrollment?.participantId !== row.participantId ||
        enrollment?.status !== "active")
    )
      denied();
  }
  return p;
}
function seal(raw: string) {
  // A public, synthetic key is allowed ONLY in the explicit demo emulator runtime.
  const demo =
    process.env.FUNCTIONS_EMULATOR === "true" &&
    process.env.GCLOUD_PROJECT === "demo-team-hangout";
  const hex = demo ? "11".repeat(32) : deliveryKey.value();
  if (!/^[a-fA-F0-9]{64}$/.test(hex))
    throw new HttpsError(
      "failed-precondition",
      "Invitation delivery encryption is not configured.",
    );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(hex, "hex"), iv);
  const ciphertext = Buffer.concat([
    cipher.update(raw, "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}
// No raw token enters a receipt, audit, list response or log. Delivery payload is encrypted separately.
function issue(resend: boolean) {
  return onCall(
    {
      secrets:
        process.env.FUNCTIONS_EMULATOR === "true" &&
        process.env.GCLOUD_PROJECT === "demo-team-hangout"
          ? []
          : [deliveryKey],
    },
    async (request) => {
      const uid = request.auth?.uid;
      if (!uid) throw new HttpsError("unauthenticated", "Sign in to continue.");
      const data = object(request.data);
      keys(
        data,
        resend
          ? ["requestId", "orgId", "invitationId", "expectedRevision"]
          : [
              "requestId",
              "orgId",
              "participantId",
              "teamId",
              "recipientEmail",
              "relationship",
              "permissions",
            ],
      );
      const requestId = id(data.requestId, "requestId");
      const orgId = id(data.orgId, "orgId");
      const payload = resend
        ? {
            orgId,
            invitationId: id(data.invitationId, "invitationId"),
            expectedRevision: revision(data.expectedRevision),
          }
        : {
            orgId,
            participantId: id(data.participantId, "participantId"),
            teamId:
              data.teamId == null || data.teamId === ""
                ? null
                : id(data.teamId, "teamId"),
            recipientEmail: email(data.recipientEmail),
            relationship: choice(
              data.relationship,
              ["guardian", "self"],
              "relationship",
            ),
            permissions: permissions(data.permissions),
          };
      // Adult self-links include contact editing under the existing participant policy.
    // Canonicalize the disclosed rights so confirmation matches the resulting authority.
    if (!resend && (payload as Data).relationship === "self") {
      (payload as Data).permissions = { viewSchedule: true, viewProfile: true, editProfile: true, respond: false };
    }
    let recipientUid: string | null = null;
      if (!resend) {
        try {
          recipientUid = (
            await getAuth().getUserByEmail((payload as Data).recipientEmail)
          ).uid;
        } catch (error) {
          if ((error as { code?: string }).code !== "auth/user-not-found")
            throw error;
        }
      }
      const fingerprint = digest(JSON.stringify(payload));
      const db = getFirestore();
      const receipt = db.doc(
        `commandRequests/${digest(`${uid}:invitation:${resend}:${orgId}:${requestId}`)}`,
      );
      return db.runTransaction(async (tx) => {
        await accountAvailable(tx, uid);
        const scope = await adminScope(tx, orgId, uid, false, false);
        const saved = (await tx.get(receipt)).data();
        if (saved) {
          if (saved.fingerprint !== fingerprint)
            throw new HttpsError(
              "already-exists",
              "This request ID was used for another change.",
            );
          return saved.result;
        }
        if (
          scope.organization.features?.organizationV2 !== true ||
          scope.organization.features?.households !== true
        )
          denied();
        if (scope.organization.status !== "active") inactive();
        const ref = invitationRef(
          orgId,
          resend
            ? (payload as Data).invitationId
            : db.collection("ids").doc().id,
        );
        const previous = resend ? (await tx.get(ref)).data() : undefined;
        if (resend && !previous) denied();
        if (resend) {
          checkRevision(previous, (payload as Data).expectedRevision);
          if (previous!.status !== "pending")
            invalid("Create a new invitation for this relationship.");
        }
        const row: Data = resend
          ? { ...previous! }
          : {
              ...payload,
              recipientUid,
              invitedBy: uid,
              acceptedBy: null,
              acceptedAt: null,
              revokedAt: null,
            };
        if (row.recipientUid) await accountAvailable(tx, row.recipientUid);
        const targetParticipant = await target(tx, row);
        row.participantAccessRevision = targetParticipant.accessRevision ?? 0;
        if (
          row.relationship === "guardian" && row.permissions.editProfile &&
          scope.organization.features?.guardianProfileEditing !== true
        )
          invalid("Guardian profile editing is not enabled.");
        const raw = randomBytes(32).toString("base64url");
        const tokenHash = digest(raw);
        const outboxId = `${ref.id}_${(previous?.revision ?? 0) + 1}`;
        const now = Timestamp.now();
        Object.assign(row, {
          tokenHash,
          outboxId,
          status: "pending",
          deliveryStatus: "queued",
          expiresAt: Timestamp.fromMillis(now.toMillis() + 7 * 86400000),
          ...metadata(uid, previous),
        });
        if (previous) {
          tx.update(db.doc(`invitationTokens/${previous.tokenHash}`), {
            status: "rotated",
          });
          tx.update(db.doc(`emailOutbox/${previous.outboxId}`), {
            status: "cancelled",
            payload: null,
          });
        }
        tx.set(ref, row);
        tx.create(db.doc(`invitationTokens/${tokenHash}`), {
          orgId,
          invitationId: ref.id,
          status: "active",
        });
        tx.create(db.doc(`emailOutbox/${outboxId}`), {
          kind: "invitation",
          orgId,
          invitationId: ref.id,
          recipientUid: row.recipientUid,
          recipientEmail: row.recipientEmail,
          status: "queued",
          payload: seal(raw),
          expiresAt: row.expiresAt,
          createdAt: now,
        });
        const result = wire({ invitation: publicRow(ref.id, row) });
        tx.create(receipt, { uid, fingerprint, result, createdAt: now });
        audit(
          tx,
          orgId,
          uid,
          resend ? "resendInvitation" : "createInvitation",
          ref.id,
          row.revision,
        );
        return result;
      });
    },
  );
}
export const createInvitation = issue(false);
export const resendInvitation = issue(true);
export const revokeInvitation = command(
  "revokeInvitation",
  (data) => {
    keys(data, ["requestId", "orgId", "invitationId", "expectedRevision"]);
    return {
      orgId: id(data.orgId, "orgId"),
      invitationId: id(data.invitationId, "invitationId"),
      expectedRevision: revision(data.expectedRevision),
    };
  },
  async (tx, payload, uid, _actor, replay) => {
    await adminScope(tx, payload.orgId, uid, false, false);
    const ref = invitationRef(payload.orgId, payload.invitationId);
    const row = (await tx.get(ref)).data();
    if (!row) denied();
    if (replay) return replay;
    checkRevision(row, payload.expectedRevision);
    if (row.status === "accepted")
      invalid("Revoke the approved relationship from the participant profile.");
    tx.update(ref, {
      status: "revoked",
      deliveryStatus: "cancelled",
      revokedAt: Timestamp.now(),
      ...metadata(uid, row),
    });
    tx.update(getFirestore().doc(`invitationTokens/${row.tokenHash}`), {
      status: "revoked",
    });
    tx.update(getFirestore().doc(`emailOutbox/${row.outboxId}`), {
      status: "cancelled",
      payload: null,
    });
    audit(tx, payload.orgId, uid, "revokeInvitation", ref.id, row.revision + 1);
    return { status: "revoked" };
  },
);
export const listInvitations = readCommand(
  (data) => {
    keys(data, ["orgId", "cursor", "pageSize"]);
    return { orgId: id(data.orgId, "orgId"), ...page(data) };
  },
  async (tx, payload, uid) => {
    await adminScope(tx, payload.orgId, uid, false, false);
    let q = getFirestore()
      .collection(`organizations/${payload.orgId}/invitations`)
      .orderBy(FieldPath.documentId())
      .limit(payload.pageSize + 1);
    if (payload.cursor) q = q.startAfter(payload.cursor);
    const docs = await tx.get(q);
    return {
      items: docs.docs
        .slice(0, payload.pageSize)
        .map((doc) => publicRow(doc.id, doc.data())),
      nextCursor:
        docs.size > payload.pageSize
          ? docs.docs[payload.pageSize - 1].id
          : null,
    };
  },
);

async function lookup(tx: Transaction, raw: string) {
  const index = (await tx.get(tokenRef(raw))).data();
  if (!index) return { status: "unavailable" };
  if (index.status !== "active")
    return { status: index.status === "rotated" ? "replaced" : index.status };
  const ref = invitationRef(index.orgId, index.invitationId);
  const row = (await tx.get(ref)).data();
  if (!row || row.tokenHash !== digest(raw)) return { status: "unavailable" };
  return { status: state(row), ref, row };
}
export const inspectInvitation = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to continue.");
  const data = object(request.data);
  keys(data, ["token"]);
  const raw = token(data.token);
  const user = await getAuth().getUser(uid);
  return getFirestore().runTransaction(async (tx) => {
    await accountAvailable(tx, uid);
    const found = await lookup(tx, raw);
    if (found.status !== "pending" || !found.row)
      return { status: found.status === "accepted" && found.row?.acceptedBy !== uid ? "used" : found.status };
    if (!user.emailVerified) return { status: "verify-email" };
    if (user.email?.toLowerCase() !== found.row.recipientEmail)
      return { status: "wrong-email" };
    if (found.row.recipientUid && found.row.recipientUid !== uid)
      return { status: "unavailable" };
    const scope = await adminScope(
      tx,
      found.row.orgId,
      found.row.invitedBy,
      true,
    );
    await accountAvailable(tx, found.row.invitedBy);
    if (scope.organization.features?.households !== true) denied();
    const p = await target(tx, found.row);
    return {
      status: "pending",
      participantName: p.displayName,
      relationship: found.row.relationship,
      permissions: found.row.permissions,
    };
  });
});
export const acceptInvitation = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to continue.");
  const data = object(request.data);
  keys(data, ["token", "confirmed"]);
  const raw = token(data.token);
  if (data.confirmed !== true)
    invalid("Confirm this relationship before accepting.");
  const user = await getAuth().getUser(uid);
  return getFirestore().runTransaction(async (tx) => {
    await accountAvailable(tx, uid);
    const found = await lookup(tx, raw);
    const row = found.row;
    // Accepted replay is informational only, never recreates a revoked grant.
    if (found.status === "accepted" && row?.acceptedBy === uid)
      return { status: "accepted" };
    if (found.status !== "pending" || !row || !found.ref)
      return { status: found.status === "accepted" ? "used" : found.status };
    if (!user.emailVerified) return { status: "verify-email" };
    if (user.email?.toLowerCase() !== row.recipientEmail)
      return { status: "wrong-email" };
    if (row.recipientUid && row.recipientUid !== uid)
      return { status: "unavailable" };
    const scope = await adminScope(tx, row.orgId, row.invitedBy, true);
    await accountAvailable(tx, row.invitedBy);
    if (scope.organization.features?.households !== true) denied();
    const p = await target(tx, row);
    if ((p.accessRevision ?? 0) !== row.participantAccessRevision)
      throw new HttpsError(
        "failed-precondition",
        "Participant access changed. Ask the organization to resend this invitation after review.",
      );
    const before = await projectionSources(tx, row.orgId, row.participantId, p);
    let after = { ...before, grants: { ...before.grants } };
    let grant: Data | null = null;
    const grantRef = participantRef(row.orgId, row.participantId)
      .collection("guardians")
      .doc(uid);
    const previousGrant = (await tx.get(grantRef)).data();
    if (row.relationship === "self") {
      if ((p.linkedUserId && p.linkedUserId !== uid) || before.grants[uid])
        invalid("Ask the organization to review the existing relationship.");
      after.linkedUserId = uid;
    } else {
      if (p.linkedUserId === uid)
        invalid("This account is already self-linked.");
      if (previousGrant?.status === "active")
        invalid("Ask the organization to review your existing permissions.");
      if (Object.keys(before.grants).length >= 10)
        throw new HttpsError(
          "resource-exhausted",
          "This participant requires a reviewed access change.",
        );
      if (
        row.relationship === "guardian" && row.permissions.editProfile &&
        scope.organization.features?.guardianProfileEditing !== true
      )
        denied();
      grant = {
        orgId: row.orgId,
        participantId: row.participantId,
        userId: uid,
        status: "active",
        permissions: row.permissions,
        grantedBy: row.invitedBy,
        grantedAt: Timestamp.now(),
        revokedAt: null,
        revokedBy: null,
        ...metadata(uid, previousGrant),
      };
      after.grants[uid] = grant;
    }
    const accessRevision = (p.accessRevision ?? 0) + 1;
    const project = await prepareProjections(
      tx,
      row.orgId,
      row.participantId,
      before,
      after,
      true,
      accessRevision,
      uid,
    );
    if (grant) tx.set(grantRef, grant);
    tx.update(participantRef(row.orgId, row.participantId), {
      linkedUserId: after.linkedUserId,
      accessRevision,
      ...metadata(uid, p),
    });
    project();
    tx.update(found.ref, {
      status: "accepted",
      deliveryStatus: "cancelled",
      acceptedBy: uid,
      recipientUid: uid,
      acceptedAt: Timestamp.now(),
      ...metadata(uid, row),
    });
    tx.update(getFirestore().doc(`emailOutbox/${row.outboxId}`), {
      status: "cancelled",
      payload: null,
      recipientUid: uid,
    });
    audit(
      tx,
      row.orgId,
      uid,
      "acceptInvitation",
      found.ref.id,
      row.revision + 1,
    );
    return { status: "accepted" };
  });
});
