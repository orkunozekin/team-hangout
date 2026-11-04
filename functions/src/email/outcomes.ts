import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { contactKey } from "./transport";
/** Trusted service-only integration. Verify provider webhook signatures upstream; never expose as a client callable. */
export async function recordDeliveryOutcome(
  outboxId: string,
  messageId: string,
  outcome: "bounce" | "complaint",
) {
  const db = getFirestore(),
    ref = db.doc(`emailOutbox/${outboxId}`);
  return db.runTransaction(async (tx) => {
    const row = (await tx.get(ref)).data();
    const invitationRef =
      row?.kind === "invitation"
        ? db.doc(`organizations/${row.orgId}/invitations/${row.invitationId}`)
        : null;
    const invitation = invitationRef
      ? (await tx.get(invitationRef)).data()
      : null;
    if (
      !row ||
      row.transportMessageId !== messageId ||
      !["sent", "failed"].includes(row.status)
    )
      return false;
    tx.update(ref, {
      status: "failed",
      failureCode: outcome === "bounce" ? "BOUNCE" : "COMPLAINT",
      updatedAt: Timestamp.now(),
    });
    tx.set(
      db.doc(`emailSuppressions/${contactKey(row.orgId, row.recipientEmail)}`),
      {
        orgId: row.orgId,
        suppressed: true,
        reason: outcome,
        updatedAt: Timestamp.now(),
      },
    );
    if (
      invitationRef &&
      invitation?.outboxId === outboxId &&
      invitation.status === "pending"
    )
      tx.update(invitationRef, { deliveryStatus: "failed" });
    return true;
  });
}
