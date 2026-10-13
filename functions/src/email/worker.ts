import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { getAuth } from "firebase-admin/auth";
import {
  FieldPath,
  getFirestore,
  Timestamp,
  Transaction,
} from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { HttpsError } from "firebase-functions/v2/https";
import { accountAvailable } from "../accountAccess";
import { Data } from "../commandSupport";
import { adminScope } from "../participants/policy";
import { target, needsReview } from "../invitations/commands";
import { eventInformation } from "./access";
import {
  contactKey,
  DeliveryFailure,
  demoRuntime,
  developmentTransport,
  Mail,
  productionTransport,
  senderConfig,
  SenderConfig,
  Transport,
} from "./transport";
const encryptionKey = defineSecret("INVITATION_DELIVERY_KEY"),
  apiKey = defineSecret("ESSENTIAL_EMAIL_API_KEY");
const MAX_ATTEMPTS = 5,
  LEASE_MS = 60000;
function unseal(payload: Data): string {
  const hex = demoRuntime() ? "11".repeat(32) : encryptionKey.value();
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(hex, "hex"),
    Buffer.from(payload.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  const raw = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]).toString();
  if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) throw new DeliveryFailure("REJECTED");
  return raw;
}
function allowedError(e: unknown) {
  return (
    e instanceof HttpsError &&
    ["permission-denied", "failed-precondition", "unauthenticated"].includes(
      e.code,
    )
  );
}
async function contact(tx: Transaction, row: Data) {
  const db = getFirestore();
  if (
    (
      await tx.get(
        db.doc(
          `emailSuppressions/${contactKey(row.orgId, row.recipientEmail)}`,
        ),
      )
    ).data()?.suppressed === true
  )
    return false;
  if (row.recipientUid) {
    const profile = await accountAvailable(tx, row.recipientUid);
    if (
      (
        await tx.get(
          db.doc(`users/${row.recipientUid}/communication/essential`),
        )
      ).data()?.suppressed === true ||
      profile.accountState === "deleting"
    )
      return false;
    try {
      const user = await getAuth().getUser(row.recipientUid);
      if (
        user.disabled ||
        user.email?.toLowerCase() !== row.recipientEmail ||
        (row.kind === "publishedEvent" && !user.emailVerified)
      )
        return false;
    } catch (e) {
      if ((e as { code?: string }).code === "auth/user-not-found") return false;
      throw e;
    }
  } else {
    if (row.kind !== "invitation") return false;
    // An account created after queuing may already be suppressed or deleting.
    try {
      const user = await getAuth().getUserByEmail(row.recipientEmail);
      if (user.disabled) return false;
      await accountAvailable(tx, user.uid);
      if (
        (
          await tx.get(db.doc(`users/${user.uid}/communication/essential`))
        ).data()?.suppressed === true
      )
        return false;
    } catch (e) {
      if ((e as { code?: string }).code !== "auth/user-not-found") throw e;
    }
  }
  return true;
}
async function prepareMail(
  tx: Transaction,
  key: string,
  row: Data,
  config: SenderConfig,
): Promise<Mail | null> {
  try {
    if (
      (await tx.get(getFirestore().doc(`organizations/${row.orgId}`))).data()
        ?.features?.essentialEmail !== true
    )
      return null;
    if (!(await contact(tx, row))) return null;
    const links = `No app installation needed. Sign in with your own account.\nHelp: ${config.browserOrigin}/help\nEmail preferences: ${config.browserOrigin}/email-preferences\nPrivacy: ${config.privacyPolicyUrl}\nReply to: ${config.replyTo}`;
    if (row.kind === "invitation") {
      const invitation = (
        await tx.get(
          getFirestore().doc(
            `organizations/${row.orgId}/invitations/${row.invitationId}`,
          ),
        )
      ).data();
      if (
        !invitation ||
        invitation.status !== "pending" ||
        invitation.outboxId !== key ||
        invitation.recipientEmail !== row.recipientEmail ||
        invitation.expiresAt.toMillis() <= Date.now() ||
        (row.invitationRevision != null &&
          invitation.revision !== row.invitationRevision)
      )
        return null;
      await accountAvailable(tx, invitation.invitedBy);
      const scope = await adminScope(tx, row.orgId, invitation.invitedBy, true),
        p = await target(tx, invitation);
      if (
        scope.organization.features?.households !== true ||
        needsReview(invitation, p, scope.organization)
      )
        return null;
      const raw = unseal(row.payload);
      if (
        createHash("sha256").update(raw).digest("hex") !==
          invitation.tokenHash ||
        (
          await tx.get(
            getFirestore().doc(`invitationTokens/${invitation.tokenHash}`),
          )
        ).data()?.status !== "active"
      )
        return null;
      const team = invitation.teamId
        ? (
            await tx.get(getFirestore().doc(`teams/${invitation.teamId}`))
          ).data()
        : null;
      return {
        to: row.recipientEmail,
        subject: `Invitation to ${scope.organization.name}`,
        text: `${scope.organization.name} invites you to review ${invitation.relationship} access.\nTeam: ${team?.name || "Choose your authorized team after sign-in"}\nTime/place: View the current published schedule after accepting. No event is confirmed by this invitation.\nReview invitation: ${config.browserOrigin}/invitation#token=${raw}\nExpires: ${invitation.expiresAt.toDate().toISOString()}\n${links}`,
      };
    }
    if (row.kind !== "publishedEvent" || !row.recipientUid) return null;
    const event = await eventInformation(tx, row.eventId, row.recipientUid);
    const stored = (
      await tx.get(getFirestore().doc(`events/${row.eventId}`))
    ).data();
    if (stored?.orgId !== row.orgId || event.revision !== row.eventRevision)
      return null;
    // Publication recipients are household contacts. Later staff grants must not rescue revoked household access.
    const access = await import("../calendar/agenda").then((m) =>
      m.readAgenda(tx, {}, row.recipientUid, { events: false }),
    );
    if (
      !access.teams.some(
        (t: Data) =>
          t.orgId === row.orgId &&
          stored!.teamIds.includes(t.id) &&
          t.participants.length,
      )
    )
      return null;
    const time = (v: Timestamp) =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: event.timeZone,
        dateStyle: "full",
        timeStyle: "short",
      }).format(v.toDate());
    return {
      to: row.recipientEmail,
      subject: `Schedule update: ${event.title}`,
      text: `${event.title}\nTeam: ${event.teams.map((t: Data) => t.name).join(", ")}\nWhen: ${time(event.startsAt)} to ${time(event.endsAt)} (${event.timeZone})\nPlace: ${event.location?.name || "Location to be confirmed"}${event.location?.address ? `, ${event.location.address}` : ""}\nPublished revision: ${event.revision}\nCurrent private information: ${config.browserOrigin}/events/${row.eventId}\n${links}`,
    };
  } catch (e) {
    if (allowedError(e)) return null;
    throw e;
  }
}
async function finish(
  key: string,
  lease: string,
  patch: Data,
  suppress = false,
) {
  const db = getFirestore(),
    ref = db.doc(`emailOutbox/${key}`);
  await db.runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data();
    const invitationRef =
      row?.kind === "invitation"
        ? db.doc(`organizations/${row.orgId}/invitations/${row.invitationId}`)
        : null;
    const invitation = invitationRef
      ? (await tx.get(invitationRef)).data()
      : null;
    if (!row || row.status !== "sending" || row.lease !== lease) return;
    tx.update(ref, {
      ...patch,
      lease: null,
      leaseUntil: null,
      updatedAt: Timestamp.now(),
    });
    if (
      invitationRef &&
      invitation?.outboxId === key &&
      invitation.status === "pending"
    )
      tx.update(invitationRef, { deliveryStatus: patch.status });
    if (suppress)
      tx.set(
        db.doc(
          `emailSuppressions/${contactKey(row.orgId, row.recipientEmail)}`,
        ),
        {
          orgId: row.orgId,
          suppressed: true,
          reason: "bounce",
          updatedAt: Timestamp.now(),
        },
      );
  });
}
export async function processOutbox(
  key: string,
  options: {
    transport?: Transport;
    config?: SenderConfig;
    beforeSend?: () => Promise<void>;
    now?: number;
  } = {},
) {
  const config = options.config ?? senderConfig();
  if (!config) return "disabled";
  const candidate = (
    await getFirestore().doc(`emailOutbox/${key}`).get()
  ).data();
  if (
    !candidate ||
    (await getFirestore().doc(`organizations/${candidate.orgId}`).get()).data()
      ?.features?.essentialEmail !== true
  )
    return "disabled";
  const transport =
    options.transport ??
    (demoRuntime()
      ? developmentTransport()
      : productionTransport(config, apiKey.value()));
  const db = getFirestore(),
    ref = db.doc(`emailOutbox/${key}`),
    lease = randomUUID(),
    now = options.now ?? Date.now();
  const claimed = await db.runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data();
    if (!row) return false;
    if (row.status === "sending") {
      if (row.leaseUntil?.toMillis() > now) return false;
      // Worker crash is ambiguous, even if it happened before calling transport. Manual reconciliation only.
      const invitationRef =
        row.kind === "invitation"
          ? db.doc(`organizations/${row.orgId}/invitations/${row.invitationId}`)
          : null;
      const invitation = invitationRef
        ? (await tx.get(invitationRef)).data()
        : null;
      tx.update(ref, {
        status: "failed",
        failureCode: "AMBIGUOUS",
        lease: null,
        leaseUntil: null,
        updatedAt: Timestamp.now(),
      });
      if (
        invitationRef &&
        invitation?.outboxId === key &&
        invitation.status === "pending"
      )
        tx.update(invitationRef, { deliveryStatus: "failed" });
      return false;
    }
    if (
      !["queued", "pending"].includes(row.status) ||
      (row.nextAttemptAt?.toMillis() ?? 0) > now
    )
      return false;
    tx.update(ref, {
      status: "sending",
      lease,
      leaseUntil: Timestamp.fromMillis(now + LEASE_MS),
      attemptCount: (row.attemptCount ?? 0) + 1,
      updatedAt: Timestamp.now(),
    });
    return true;
  });
  if (!claimed) return "skipped";
  let invoked = false;
  try {
    await options.beforeSend?.();
    // Final authorization happens after leasing, immediately before the external side effect.
    const mail = await db.runTransaction(async (tx) => {
      const row = (await tx.get(ref)).data();
      if (
        !row ||
        row.status !== "sending" ||
        row.lease !== lease ||
        row.leaseUntil.toMillis() <= Date.now()
      )
        return null;
      return prepareMail(tx, key, row, config);
    });
    if (!mail) {
      await finish(key, lease, {
        status: "cancelled",
        failureCode: "SUPPRESSED_OR_STALE",
        payload: null,
      });
      return "cancelled";
    }
    invoked = true;
    const messageId = await transport.send(key, mail);
    await finish(key, lease, {
      status: "sent",
      transportMessageId: messageId,
      failureCode: null,
      sentAt: Timestamp.now(),
      payload: null,
    });
    return "sent";
  } catch (e) {
    const code =
      e instanceof DeliveryFailure
        ? e.code
        : invoked
          ? "AMBIGUOUS"
          : "PRE_SEND";
    // Errors after invocation with no known classification must be ambiguous. Adapter contract requires DeliveryFailure.
    const row = (await ref.get()).data();
    const retry =
      code === "PRE_SEND" && (row?.attemptCount ?? MAX_ATTEMPTS) < MAX_ATTEMPTS;
    await finish(
      key,
      lease,
      {
        status: retry ? "pending" : "failed",
        failureCode: code,
        nextAttemptAt: Timestamp.fromMillis(
          Date.now() +
            Math.min(
              3600000,
              30000 * 2 ** Math.min(row?.attemptCount ?? 1, MAX_ATTEMPTS),
            ),
        ),
      },
      code === "BOUNCE",
    );
    return retry ? "pending" : "failed";
  }
}
export const resumeEssentialEmail = onSchedule(
  {
    schedule: "every 1 minutes",
    secrets: demoRuntime() ? [] : [encryptionKey, apiKey],
  },
  async () => {
    if (!senderConfig()) return;
    const db = getFirestore();
    // Persist scan positions so disabled organizations or future retries cannot starve later rows.
    for (const state of ["queued", "pending", "sending"]) {
      const scan = db.doc(`emailWorkerScans/${state}`);
      const cursor = (await scan.get()).data()?.cursor;
      let query = db
        .collection("emailOutbox")
        .where("status", "==", state)
        .orderBy(FieldPath.documentId())
        .limit(25);
      if (cursor) query = query.startAfter(cursor);
      const rows = await query.get();
      for (const row of rows.docs) await processOutbox(row.id);
      await scan.set({
        cursor: rows.size === 25 ? rows.docs[24].id : null,
        updatedAt: Timestamp.now(),
      });
    }
  },
);
