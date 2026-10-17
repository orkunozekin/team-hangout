import { getFirestore, Timestamp, Transaction } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import {
  command,
  Data,
  id,
  invalid,
  keys,
  revision,
  text,
} from "../commandSupport";
import { adminScope, readCommand } from "../participants/policy";
import { checkRevision, denied, eventScope } from "../operations/access";
import { fingerprint } from "../operations/requests";
import { cacheDocumentReads } from "../operations/reads";
import { audit } from "../organizations/commands";
import { lockRef, publicationError as fail } from "../scheduling/lease";
import { publishedEvent } from "../scheduling/visibility";
import { commitResourceAssignment, instant } from "./service";
import { overlaps } from "./intervals";
import type { Interval } from "./intervals";

const db = () => getFirestore();
const closureRef = (orgId: string, closureId: string) =>
  db().doc(`organizations/${orgId}/closures/${closureId}`);
const opRef = (orgId: string, operationId: string) =>
  db().doc(`organizations/${orgId}/scheduleOperations/${operationId}`);
const bounded = (size: number, max: number, kind: string) => {
  if (size > max)
    throw new HttpsError(
      "resource-exhausted",
      `${kind} exceeds the safe ${max} record limit. Nothing was truncated.`,
    );
};
export function eventInterval(e: Data) {
  const span = e.resourceOccupancy ?? e;
  return {
    startsAt: span.startsAt.toDate().toISOString(),
    endsAt: span.endsAt.toDate().toISOString(),
  };
}
type ClosureWindow = {
  span: Interval;
  rows: Promise<FirebaseFirestore.QuerySnapshot>;
};
const closureReads = new WeakMap<Transaction, Map<string, ClosureWindow>>();
/** Bounded to applied closures intersecting the requested read window, never lifetime history. */
export async function resourceClosures(
  tx: Transaction,
  orgId: string,
  facilityId: string,
  span: Interval,
) {
  let reads = closureReads.get(tx);
  if (!reads) {
    reads = new Map();
    closureReads.set(tx, reads);
  }
  const key = `${orgId}/${facilityId}`,
    previous = reads.get(key);
  if (
    previous &&
    previous.span.startsAt <= span.startsAt &&
    previous.span.endsAt >= span.endsAt
  )
    return previous.rows;
  const window = previous
    ? {
        startsAt: [previous.span.startsAt, span.startsAt].sort()[0],
        endsAt: [previous.span.endsAt, span.endsAt].sort().at(-1)!,
      }
    : span;
  const rows = tx
    .get(
      db()
        .collection(`organizations/${orgId}/closures`)
        .where("facilityId", "==", facilityId)
        .where("status", "==", "applied")
        .where("endsAt", ">", window.startsAt)
        .where("startsAt", "<", window.endsAt)
        .limit(1001),
    )
    .then((result) => {
      bounded(result.size, 1000, "Overlapping facility closures");
      return result;
    });
  reads.set(key, { span: window, rows });
  return rows;
}
/** Prime the finite visible page as one interval window per facility and transaction attempt. */
export async function primeClosureReads(tx: Transaction, events: Data[]) {
  const windows = new Map<
    string,
    { orgId: string; facilityId: string; span: Interval }
  >();
  for (const event of events) {
    if (
      !event.orgId ||
      !event.facilityId ||
      !event.resourceId ||
      !["scheduled", "postponed", "completed"].includes(event.status)
    )
      continue;
    const span = eventInterval(event),
      key = `${event.orgId}/${event.facilityId}`,
      previous = windows.get(key);
    windows.set(key, {
      orgId: event.orgId,
      facilityId: event.facilityId,
      span: previous
        ? {
            startsAt: [previous.span.startsAt, span.startsAt].sort()[0],
            endsAt: [previous.span.endsAt, span.endsAt].sort().at(-1)!,
          }
        : span,
    });
  }
  await Promise.all(
    [...windows.values()].map((w) =>
      resourceClosures(tx, w.orgId, w.facilityId, w.span),
    ),
  );
}
export async function effectiveClosure(tx: Transaction, event: Data) {
  if (
    !event.orgId ||
    !event.facilityId ||
    !event.resourceId ||
    !["scheduled", "postponed", "completed"].includes(event.status)
  )
    return false;
  const span = eventInterval(event),
    rows = await resourceClosures(tx, event.orgId, event.facilityId, span);
  return rows.docs.some((row) => {
    const c = row.data();
    return (
      c.schemaVersion === 2 &&
      c.orgId === event.orgId &&
      c.status === "applied" &&
      c.resourceIds.includes(event.resourceId) &&
      overlaps(span, { startsAt: c.startsAt, endsAt: c.endsAt })
    );
  });
}
export async function effectiveEvent(
  tx: Transaction,
  event: Data,
): Promise<Data> {
  const closed = await effectiveClosure(tx, event);
  return {
    ...event,
    ...(closed && event.status === "scheduled" ? { status: "postponed" } : {}),
    resourceClosed: closed,
    closureUpdatePending: closed && event.status === "scheduled",
  };
}
export async function requireOpenInterval(tx: Transaction, event: Data) {
  if (await effectiveClosure(tx, { ...event, status: "scheduled" }))
    fail(
      "RESOURCE_CLOSED",
      "This resource interval is closed. Review a different time or resource.",
    );
}
async function authority(tx: Transaction, orgId: string, uid: string) {
  // A shared physical closure can affect every program. Only organization administrators may apply it.
  const s = await adminScope(tx, orgId, uid, true);
  if (s.organization.features?.adminWorkspace !== true) denied();
}
function intervalInput(d: Data) {
  const startsAt = instant(d.startsAt, "startsAt"),
    endsAt = instant(d.endsAt, "endsAt");
  if (
    endsAt <= startsAt ||
    Date.parse(endsAt) - Date.parse(startsAt) > 112 * 86400000
  )
    invalid("Choose an ordered closure interval of at most 16 weeks.");
  if (
    d.resourceIds !== null &&
    (!Array.isArray(d.resourceIds) ||
      !d.resourceIds.length ||
      d.resourceIds.length > 1000 ||
      new Set(d.resourceIds).size !== d.resourceIds.length)
  )
    invalid("Choose resources or the whole facility.");
  return {
    orgId: id(d.orgId, "orgId"),
    facilityId: id(d.facilityId, "facilityId"),
    startsAt,
    endsAt,
    resourceIds:
      d.resourceIds === null
        ? null
        : d.resourceIds.map((v: unknown) => id(v, "resourceId")).sort(),
    reason: text(d.reason, "reason", 500),
  };
}
async function snapshot(tx: Transaction, d: Data, uid: string) {
  await authority(tx, d.orgId, uid);
  const facility = (
    await tx.get(
      db().doc(`organizations/${d.orgId}/facilities/${d.facilityId}`),
    )
  ).data();
  if (
    facility?.schemaVersion !== 2 ||
    facility.orgId !== d.orgId ||
    facility.status !== "active"
  )
    denied();
  const resources = await tx.get(
    db()
      .collection(
        `organizations/${d.orgId}/facilities/${d.facilityId}/resources`,
      )
      .limit(1001),
  );
  bounded(resources.size, 1000, "Facility resources");
  const selected = resources.docs.filter((r) =>
    d.resourceIds === null
      ? r.data().status === "active"
      : d.resourceIds.includes(r.id),
  );
  if (
    !selected.length ||
    (d.resourceIds !== null && selected.length !== d.resourceIds.length) ||
    selected.some(
      (r) =>
        r.data().schemaVersion !== 2 ||
        r.data().orgId !== d.orgId ||
        r.data().facilityId !== d.facilityId ||
        r.data().status !== "active",
    )
  )
    denied();
  const resourceIds = selected.map((r) => r.id).sort();
  // Resource bookings are at most 24 hours plus 3 hours cleanup/setup. Include boundary-spanning occupancy.
  const rows = await tx.get(
    db()
      .collection("events")
      .where("orgId", "==", d.orgId)
      .where("facilityId", "==", d.facilityId)
      .where("status", "==", "scheduled")
      .where("publicationState", "==", "published")
      .where("deletedAt", "==", null)
      .where(
        "startsAt",
        ">=",
        Timestamp.fromMillis(Date.parse(d.startsAt) - 27 * 3600000),
      )
      .where(
        "startsAt",
        "<",
        Timestamp.fromMillis(Date.parse(d.endsAt) + 3 * 3600000),
      )
      .limit(1001),
  );
  bounded(rows.size, 1000, "Facility events");
  const impacted: Data[] = [];
  for (const doc of rows.docs) {
    const e = doc.data();
    if (
      e.schemaVersion !== 2 ||
      e.status !== "scheduled" ||
      !resourceIds.includes(e.resourceId) ||
      !(await publishedEvent(tx, e)) ||
      !overlaps(eventInterval(e), d as any)
    )
      continue;
    const scope = await eventScope(tx, e.teamIds, uid);
    if (scope.orgId !== d.orgId) denied();
    impacted.push({
      eventId: doc.id,
      revision: e.revision,
      title: e.title,
      startsAt: e.startsAt.toDate().toISOString(),
      endsAt: e.endsAt.toDate().toISOString(),
      resourceId: e.resourceId,
      teamIds: e.teamIds,
      teamNames: scope.teams.map((t) => t.name),
      timeZone: e.timeZone,
    });
  }
  impacted.sort((a, b) => a.eventId.localeCompare(b.eventId));
  const lock = (await tx.get(lockRef(d.orgId))).data();
  if (lock?.operationId)
    fail(
      "SCHEDULING_BUSY",
      "Finish or recover the current scheduling operation before reviewing a closure.",
    );
  const hash = fingerprint({
    fields: d,
    facility,
    resources: selected.map((r) => [r.id, r.data()]),
    impacted,
    inputRevision: lock?.inputRevision ?? 0,
  });
  return { resourceIds, impacted, hash, lock };
}
export const previewFacilityClosure = command(
  "previewFacilityClosure",
  (d) => {
    keys(d, [
      "requestId",
      "orgId",
      "facilityId",
      "resourceIds",
      "startsAt",
      "endsAt",
      "reason",
    ]);
    return intervalInput(d);
  },
  async (tx, d, uid, _actor, replay) => {
    await authority(tx, d.orgId, uid);
    if (replay) return replay;
    const current = await snapshot(tx, d, uid),
      ref = db().collection(`organizations/${d.orgId}/closurePreviews`).doc();
    const result = {
      previewId: ref.id,
      previewHash: current.hash,
      facilityId: d.facilityId,
      resourceIds: current.resourceIds,
      startsAt: d.startsAt,
      endsAt: d.endsAt,
      reason: d.reason,
      impacted: current.impacted,
    };
    if (Buffer.byteLength(JSON.stringify(result)) > 750000)
      throw new HttpsError(
        "resource-exhausted",
        "Closure preview exceeds the safe record budget. Nothing was truncated.",
      );
    tx.create(ref, {
      schemaVersion: 2,
      orgId: d.orgId,
      fields: d,
      ...result,
      createdAt: Timestamp.now(),
    });
    return result;
  },
);
function progress(row: Data) {
  return {
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    operationId: row.operationId,
    closureId: row.closureId,
    revision: row.revision,
    fencingToken: row.fencingToken,
    state: row.state,
    cursor: row.cursor,
    total: row.expected.length,
    impacted: row.expected,
    postponed: row.postponed,
    mismatches: row.mismatches,
    expiresAt: row.expiresAt,
  };
}
export const applyFacilityClosure = command(
  "applyFacilityClosure",
  (d) => {
    keys(d, ["requestId", "orgId", "previewId", "previewHash", "confirmed"]);
    if (d.confirmed !== true)
      invalid("Explicitly confirm the reviewed closure.");
    return {
      orgId: id(d.orgId, "orgId"),
      previewId: id(d.previewId, "previewId"),
      previewHash: text(d.previewHash, "previewHash", 64),
      confirmed: true,
    };
  },
  async (tx, d, uid, _actor, replay) => {
    await authority(tx, d.orgId, uid);
    if (replay)
      return progress(
        (await tx.get(opRef(d.orgId, replay.operationId))).data()!,
      );
    const p = (
      await tx.get(
        db().doc(`organizations/${d.orgId}/closurePreviews/${d.previewId}`),
      )
    ).data();
    if (!p || p.orgId !== d.orgId || p.schemaVersion !== 2) denied();
    const current = await snapshot(tx, p.fields, uid);
    if (p.previewHash !== d.previewHash || current.hash !== d.previewHash)
      fail(
        "STALE_PREVIEW",
        "Closure inputs changed. Review a new impact preview.",
      );
    const ref = closureRef(d.orgId, d.previewId),
      old = await tx.get(ref);
    if (old.exists)
      fail(
        "ALREADY_APPLIED",
        "This closure was already applied. Reload its operation.",
      );
    const now = Timestamp.now(),
      operationId = `closure_${d.previewId}`,
      fencingToken = (current.lock?.fencingToken ?? 0) + 1;
    const row = {
      schemaVersion: 2,
      orgId: d.orgId,
      operationId,
      closureId: ref.id,
      action: "facilityClosure",
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      revision: 1,
      fencingToken,
      state: current.impacted.length ? "running" : "committed",
      cursor: 0,
      postponed: 0,
      mismatches: [],
      expected: current.impacted,
      createdAt: now,
      updatedAt: now,
      auditCorrelationId: operationId,
      expiresAt: Timestamp.fromMillis(now.toMillis() + 120000),
    };
    tx.create(ref, {
      schemaVersion: 2,
      ...p.fields,
      resourceIds: current.resourceIds,
      operationId,
      revision: 1,
      status: "applied",
      appliedAt: now,
      createdAt: now,
      updatedAt: now,
      auditCorrelationId: operationId,
    });
    tx.create(opRef(d.orgId, operationId), row);
    tx.set(lockRef(d.orgId), {
      schemaVersion: 2,
      orgId: d.orgId,
      inputRevision: (current.lock?.inputRevision ?? 0) + 1,
      visibilityRevision: (current.lock?.visibilityRevision ?? 0) + 1,
      fencingToken,
      operationId: current.impacted.length ? operationId : null,
      expiresAt: row.expiresAt,
    });
    tx.create(db().doc(`organizations/${d.orgId}/outbox/${operationId}`), {
      schemaVersion: 2,
      orgId: d.orgId,
      sourceType: "closure",
      sourceId: ref.id,
      sourceRevision: 1,
      operationId,
      templateKey: "facilityClosure",
      critical: true,
      state: "pending",
      audience: { facilityId: p.facilityId },
      createdAt: now,
      updatedAt: now,
      auditCorrelationId: operationId,
    });
    audit(tx, d.orgId, uid, "applyFacilityClosure", ref.id, 1);
    return progress(row);
  },
);
async function load(tx: Transaction, d: Data, uid: string) {
  await authority(tx, d.orgId, uid);
  const row = (await tx.get(opRef(d.orgId, d.operationId))).data();
  if (
    !row ||
    row.schemaVersion !== 2 ||
    row.orgId !== d.orgId ||
    row.action !== "facilityClosure"
  )
    denied();
  return row!;
}
export const getFacilityClosureOperation = readCommand(
  (d) => {
    keys(d, ["orgId", "operationId"]);
    return {
      orgId: id(d.orgId, "orgId"),
      operationId: id(d.operationId, "operationId"),
    };
  },
  async (tx, d, uid) => progress(await load(cacheDocumentReads(tx), d, uid)),
);
export const advanceFacilityClosure = command(
  "advanceFacilityClosure",
  (d) => {
    keys(d, [
      "requestId",
      "orgId",
      "operationId",
      "expectedRevision",
      "fencingToken",
      "action",
    ]);
    if (!["advance", "resume"].includes(d.action))
      invalid("Choose advance or resume.");
    return {
      orgId: id(d.orgId, "orgId"),
      operationId: id(d.operationId, "operationId"),
      expectedRevision: revision(d.expectedRevision),
      fencingToken: revision(d.fencingToken),
      action: d.action,
    };
  },
  async (tx, d, uid, _actor, replay) => {
    const row = await load(tx, d, uid);
    if (replay) return progress(row);
    checkRevision(row, d.expectedRevision);
    if (row.state === "committed") return progress(row);
    const lock = (await tx.get(lockRef(d.orgId))).data();
    if (
      lock?.operationId !== row.operationId ||
      lock!.fencingToken !== row.fencingToken ||
      d.fencingToken !== row.fencingToken
    )
      fail("STALE_FENCE", "Reload the current closure operation.");
    const now = Timestamp.now();
    if (d.action === "resume") {
      const next = {
        ...row,
        fencingToken: row.fencingToken + 1,
        revision: row.revision + 1,
        expiresAt: Timestamp.fromMillis(now.toMillis() + 120000),
        updatedAt: now,
      };
      tx.update(opRef(d.orgId, d.operationId), next);
      tx.update(lockRef(d.orgId), {
        fencingToken: next.fencingToken,
        expiresAt: next.expiresAt,
      });
      audit(
        tx,
        d.orgId,
        uid,
        "resumeFacilityClosure",
        row.closureId,
        next.revision,
      );
      return progress(next);
    }
    if (lock!.expiresAt.toMillis() <= now.toMillis())
      fail(
        "LEASE_EXPIRED",
        "Resume the interrupted closure before continuing. The interval remains closed.",
      );
    const c = (await tx.get(closureRef(d.orgId, row.closureId))).data();
    if (
      c?.status !== "applied" ||
      c.orgId !== d.orgId ||
      c.operationId !== row.operationId
    )
      fail("CLOSURE_MISMATCH", "The closure record needs operator review.");
    const item = row.expected[row.cursor],
      ref = db().doc(`events/${item.eventId}`),
      event = (await tx.get(ref)).data();
    let mismatch =
      !event ||
      event.orgId !== d.orgId ||
      event.revision !== item.revision ||
      event.status !== "scheduled";
    if (event?.orgId === d.orgId) {
      const s = await eventScope(tx, event!.teamIds, uid);
      if (s.orgId !== d.orgId) denied();
    }
    if (!mismatch)
      mismatch =
        !(await publishedEvent(tx, event!)) ||
        event!.facilityId !== c.facilityId ||
        !c.resourceIds.includes(event!.resourceId) ||
        !overlaps(eventInterval(event!), c as any);
    const next: Data = {
      ...row,
      expiresAt: Timestamp.fromMillis(now.toMillis() + 120000),
      cursor: row.cursor + 1,
      revision: row.revision + 1,
      updatedAt: now,
      postponed: row.postponed + (mismatch ? 0 : 1),
      mismatches: mismatch ? [...row.mismatches, item.eventId] : row.mismatches,
    };
    if (next.cursor === row.expected.length) next.state = "committed";
    if (!mismatch) {
      const e = event!,
        nextRevision = e.revision + 1;
      commitResourceAssignment(
        tx,
        { ...e, status: "postponed" },
        {},
        ref.id,
        nextRevision,
        e,
      );
      tx.create(ref.collection("scheduleHistory").doc(String(nextRevision)), {
        schemaVersion: 2,
        revision: nextRevision,
        action: "postpone",
        reason: c.reason,
        previousStatus: e.status,
        status: "postponed",
        previousTimeZone: e.timeZone,
        timeZone: e.timeZone,
        previousStartsAt: e.startsAt,
        previousEndsAt: e.endsAt,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        createdAt: now,
        closureId: row.closureId,
      });
      tx.update(ref, {
        status: "postponed",
        revision: nextRevision,
        postponementReason: c.reason,
        closureId: row.closureId,
        updatedAt: now,
        updatedBy: uid,
      });
      tx.create(
        db().doc(
          `organizations/${d.orgId}/outbox/${fingerprint({ eventId: ref.id, revision: nextRevision, kind: "postpone" })}`,
        ),
        {
          schemaVersion: 2,
          orgId: d.orgId,
          sourceType: "event",
          sourceId: ref.id,
          sourceRevision: nextRevision,
          operationId: row.operationId,
          templateKey: "eventPostponed",
          critical: true,
          state: "pending",
          audience: { teamIds: e.teamIds },
          createdAt: now,
          updatedAt: now,
          auditCorrelationId: row.operationId,
        },
      );
      audit(tx, d.orgId, uid, "closurePostpone", ref.id, nextRevision);
    }
    tx.update(opRef(d.orgId, d.operationId), next);
    tx.update(lockRef(d.orgId), {
      ...(next.state === "committed"
        ? { operationId: null, inputRevision: lock!.inputRevision + 1 }
        : {}),
      expiresAt: next.expiresAt,
    });
    return progress(next);
  },
);
