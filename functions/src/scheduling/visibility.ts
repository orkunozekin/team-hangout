import { getFirestore, Transaction } from "firebase-admin/firestore";
import type { Data } from "../commandSupport";
/** Server-owned null markers are the Phase 1 single-event compatibility contract. */
export async function publishedEvent(tx: Transaction, event: Data) {
  if (event.deletedAt != null || event.publicationState !== "published")
    return false;
  if (event.publicationOperationId === null) return true;
  if (
    typeof event.publicationOperationId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(event.publicationOperationId) ||
    typeof event.orgId !== "string"
  )
    return false;
  const marker = (
    await tx.get(
      getFirestore().doc(
        `organizations/${event.orgId}/scheduleOperations/${event.publicationOperationId}`,
      ),
    )
  ).data();
  return (
    marker?.schemaVersion === 2 &&
    marker.orgId === event.orgId &&
    marker.state === "committed"
  );
}
