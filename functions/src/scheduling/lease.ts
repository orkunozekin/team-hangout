import {
  getFirestore,
  Timestamp,
  Transaction,
  Firestore,
} from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import type { Data } from "../commandSupport";
export const lockRef = (orgId: string, database: Firestore = getFirestore()) =>
  database.doc(`organizations/${orgId}/schedulingLock/current`);
export function publicationError(code: string, message: string): never {
  throw new HttpsError("failed-precondition", message, { domainCode: code });
}
/** Reads precede all writes; the returned write serializes even a mutation that started before acquisition. */
export async function scheduleMutation(
  tx: Transaction,
  orgId: string,
  deferBusy = false,
  database: Firestore = getFirestore(),
) {
  const ref = lockRef(orgId, database),
    row = (await tx.get(ref)).data();
  // Expiry never releases an unfinished operation. It requires deliberate recovery or abort.
  if (row?.operationId) {
    const busy = () =>
      publicationError(
        "SCHEDULING_BUSY",
        "A schedule publication needs recovery or completion before schedule changes.",
      );
    if (deferBusy) return busy;
    busy();
  }
  return () =>
    tx.set(ref, {
      schemaVersion: 2,
      orgId,
      inputRevision: (row?.inputRevision ?? 0) + 1,
      visibilityRevision: row?.visibilityRevision ?? 0,
      fencingToken: row?.fencingToken ?? 0,
      operationId: null,
      expiresAt: Timestamp.fromMillis(0),
    });
}
const names = new Set([
  "generateScheduleDraft",
  "saveScheduleDraft",
  "validateScheduleDraft",
  "createEvent",
  "updateEvent",
  "softDeleteEvent",
  "mutateEventSchedule",
  "saveFacility",
  "saveFacilityResource",
  "appendResourceAvailability",
  "saveHierarchyEntity",
  "saveTeam",
  "archiveSeason",
]);
export async function commandScheduleMutation(
  tx: Transaction,
  name: string,
  data: Data,
) {
  if (!names.has(name)) return null;
  let orgId = data.orgId;
  if (!orgId && data.eventId)
    orgId = (await tx.get(getFirestore().doc(`events/${data.eventId}`))).data()
      ?.orgId;
  if (!orgId && data.teamId)
    orgId = (await tx.get(getFirestore().doc(`teams/${data.teamId}`))).data()
      ?.orgId;
  return orgId ? scheduleMutation(tx, orgId, true) : null;
}
