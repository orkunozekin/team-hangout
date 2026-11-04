import { getFirestore, Timestamp, Transaction } from "firebase-admin/firestore";
import { Data } from "../commandSupport";

export function criticalUpdateRef(orgId: string, notificationId: string) {
  return getFirestore().doc(`organizations/${orgId}/criticalUpdates/${notificationId}`);
}

/** Staff-visible delivery outcome. Never store an address, token or message body. */
export function recordDeliveryIssue(
  tx: Transaction,
  row: Data,
  status: string,
  failureCode: string | null,
) {
  if (!row?.orgId || typeof row.id !== "string") return;
  if (!["permanentFailure", "unknownOutcome"].includes(status)) return;
  const now = Timestamp.now();
  tx.set(
    getFirestore().doc(`organizations/${row.orgId}/deliveryIssues/${row.id}`),
    {
      schemaVersion: 2,
      orgId: row.orgId,
      deliveryId: row.id,
      channel: row.channel ?? "fake",
      status,
      failureCode: failureCode ?? null,
      sourceType: row.sourceType ?? null,
      sourceId: row.sourceId ?? null,
      sourceRevision: row.sourceRevision ?? null,
      templateKey: row.templateKey ?? null,
      programId: row.programId ?? null,
      recipientUid: row.recipientUid ?? null,
      updatedAt: now,
      createdAt: row.createdAt ?? now,
    },
    { merge: true },
  );
}

export function recordCriticalUpdate(
  tx: Transaction,
  orgId: string,
  notificationId: string,
  row: Data,
) {
  const now = Timestamp.now();
  tx.set(criticalUpdateRef(orgId, notificationId), {
    schemaVersion: 2,
    orgId,
    notificationId,
    recipientUid: row.recipientUid,
    title: row.title,
    sourceType: row.sourceType ?? null,
    sourceId: row.sourceId ?? null,
    sourceRevision: row.sourceRevision ?? null,
    templateKey: row.templateKey ?? null,
    programId: row.programId ?? null,
    acknowledgedAt: null,
    readAt: null,
    createdAt: row.createdAt ?? now,
    updatedAt: now,
  });
}

/** Idempotent provider bounce. This records transport failure and does not acknowledge anything. */
export async function recordNotificationEmailBounce(
  deliveryId: string,
  providerEventId: string,
) {
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(providerEventId))
    throw new Error("INVALID_BOUNCE_EVENT");
  const db = getFirestore();
  const ref = db.doc(`notificationDeliveries/${deliveryId}`);
  return db.runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data();
    if (!row || row.channel !== "email") return { applied: false, reason: "not_email" };
    if (row.bounceEventId === providerEventId)
      return { applied: true, reason: "duplicate", failureCode: "EMAIL_BOUNCED" };
    if (row.status === "permanentFailure" && row.failureCode === "EMAIL_BOUNCED")
      return { applied: false, reason: "already_bounced", failureCode: "EMAIL_BOUNCED" };
    const notification = await tx.get(
      db.doc(`users/${row.recipientUid}/notifications/${row.notificationId}`),
    );
    const now = Timestamp.now();
    tx.update(ref, {
      status: "permanentFailure",
      failureCode: "EMAIL_BOUNCED",
      bounceEventId: providerEventId,
      nextAttemptAt: null,
      lease: null,
      leaseUntil: null,
      updatedAt: now,
    });
    if (notification.exists) {
      const current = notification.data()?.deliveryStatus;
      const succeeded = ["providerAccepted", "providerReceiptOk"].includes(current);
      tx.update(notification.ref, {
        "deliveryStatuses.email": "permanentFailure",
        deliveryStatus: succeeded ? current : "permanentFailure",
        updatedAt: now,
      });
    }
    recordDeliveryIssue(
      tx,
      { ...row, id: row.id ?? deliveryId },
      "permanentFailure",
      "EMAIL_BOUNCED",
    );
    return { applied: true, reason: "recorded", failureCode: "EMAIL_BOUNCED" };
  });
}
