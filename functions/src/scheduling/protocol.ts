import { getFirestore, Transaction } from "firebase-admin/firestore";
import { Data, wire } from "../commandSupport";
import { fingerprint } from "../operations/requests";
import { publicationError as fail } from "./lease";
const db = () => getFirestore();
export const payloadHash = (e: Data) => {
  const { publicationState, createdAt, updatedAt, ...body } = e;
  return fingerprint(wire(body));
};
/** Internal protocol only. The callable owns live authority, snapshot validation, lease and marker/outbox commit. */
export async function publicationPass(
  tx: Transaction,
  op: Data,
  payload: (fixtureId: string) => Promise<Data>,
): Promise<Data> {
  const next: Data = { ...op };
  if (op.state === "staging" || op.state === "promoting") {
    const staging = op.state === "staging",
      cursor = staging ? op.stagingCursor : op.promotionCursor;
    const entries = op.expected.slice(cursor, cursor + 100);
    const writes: { eventId: string; event: Data }[] = [];
    for (const e of entries) {
      const existing = (await tx.get(db().doc(`events/${e.eventId}`))).data();
      if (staging) {
        if (existing)
          fail(
            "EVENT_CHANGED",
            "A deterministic publication event already exists. Review recovery.",
          );
        const event = await payload(e.fixtureId);
        if (
          event.publicationOperationId !== op.operationId ||
          event.orgId !== op.orgId ||
          event.revision !== e.revision ||
          payloadHash(event) !== e.hash
        )
          fail("EVENT_CHANGED", "Expected event payload changed.");
        writes.push({
          eventId: e.eventId,
          event: { ...event, createdAt: op.createdAt, updatedAt: op.createdAt },
        });
      } else if (
        !existing ||
        existing.publicationOperationId !== op.operationId ||
        existing.orgId !== op.orgId ||
        existing.publicationState !== "staged" ||
        existing.revision !== e.revision ||
        payloadHash(existing) !== e.hash
      )
        fail(
          "EVENT_CHANGED",
          "A staged event is missing or changed. Abort and review.",
        );
    }
    if (staging)
      for (const w of writes) {
        tx.create(db().doc(`events/${w.eventId}`), w.event);
        if (w.event.resourceOccupancy)
          tx.create(db().doc(`events/${w.eventId}/resourceHistory/1`), {
            schemaVersion: 2,
            revision: 1,
            orgId: w.event.orgId,
            facilityId: w.event.facilityId,
            resourceId: w.event.resourceId,
            status: w.event.status,
            occupancy: w.event.resourceOccupancy,
            previousFacilityId: null,
            previousResourceId: null,
            previousOccupancy: null,
            createdAt: op.createdAt,
            updatedAt: op.createdAt,
            auditCorrelationId: `${w.eventId}:1`,
          });
      }
    else
      for (const e of entries)
        tx.update(db().doc(`events/${e.eventId}`), {
          publicationState: "published",
        });
    if (staging) {
      next.stagingCursor += entries.length;
      if (next.stagingCursor === op.expected.length) next.state = "promoting";
    } else {
      next.promotionCursor += entries.length;
      if (next.promotionCursor === op.expected.length) next.state = "verifying";
    }
  } else if (op.state === "verifying") {
    if (
      op.stagingCursor !== op.expected.length ||
      op.promotionCursor !== op.expected.length ||
      !op.expected.length ||
      new Set(op.expected.map((e: Data) => e.eventId)).size !==
        op.expected.length
    )
      fail("INCOMPLETE_PUBLICATION", "Publication passes are incomplete.");
    const rows = await tx.getAll(
      ...op.expected.map((e: Data) => db().doc(`events/${e.eventId}`)),
    );
    for (let i = 0; i < rows.length; i++) {
      const event = rows[i].data() as Data | undefined,
        e = op.expected[i];
      if (
        !event ||
        event.publicationOperationId !== op.operationId ||
        event.orgId !== op.orgId ||
        event.publicationState !== "published" ||
        event.revision !== e.revision ||
        payloadHash(event) !== e.hash
      )
        fail(
          "EVENT_CHANGED",
          "The complete expected event set failed verification.",
        );
    }
    next.state = "committed";
  } else fail("INVALID_STATE", "Publication state needs operator review.");
  return next;
}
