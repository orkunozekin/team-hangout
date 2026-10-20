import { getFirestore, Query } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { Data, id, invalid, keys } from "../commandSupport";
import { denied, staffScope } from "../operations/access";
import { readCommand } from "../participants/policy";

function failureQuery(orgId: string, programIds: string[] | null) {
  const collection = getFirestore().collection(`organizations/${orgId}/deliveryIssues`);
  const scoped = programIds ? collection.where("programId", "in", programIds) : collection;
  return scoped.orderBy("updatedAt", "desc");
}
function acknowledgementQuery(orgId: string, programIds: string[] | null) {
  const collection = getFirestore().collection(`organizations/${orgId}/criticalUpdates`);
  const scoped = programIds
    ? collection.where("programId", "in", programIds).where("acknowledgedAt", "==", null)
    : collection.where("acknowledgedAt", "==", null);
  return scoped.orderBy("createdAt", "desc");
}
function programGroups(programIds: string[] | null): (string[] | null)[] {
  if (!programIds) return [null];
  const groups: (string[] | null)[] = [];
  for (let index = 0; index < programIds.length; index += 10)
    groups.push(programIds.slice(index, index + 10));
  return groups;
}
function instantMillis(value: { toMillis?: () => number } | null | undefined) {
  const millis = value?.toMillis?.();
  return typeof millis === "number" && Number.isFinite(millis) ? millis : 0;
}
/** Firestore `in` filters accept 10 values. Staff may hold 20 programs, so pages merge those chunks. */
async function readMergedPage(
  tx: FirebaseFirestore.Transaction,
  queryFor: (programIds: string[] | null) => Query,
  programIds: string[] | null,
  orgId: string,
  collection: "deliveryIssues" | "criticalUpdates",
  cursor: string | null,
  pageSize: number,
  rank: (row: Data) => { toMillis?: () => number } | null | undefined,
  map: (row: Data, id: string) => Data,
) {
  let snapshot: FirebaseFirestore.DocumentSnapshot | null = null;
  if (cursor) {
    snapshot = await tx.get(
      getFirestore().doc(`organizations/${orgId}/${collection}/${cursor}`),
    );
    if (!snapshot.exists) invalid("Invalid cursor.");
  }
  const ranked: { id: string; millis: number; item: Data }[] = [];
  for (const group of programGroups(programIds)) {
    let query = queryFor(group);
    if (snapshot) query = query.startAfter(snapshot);
    const rows = await tx.get(query.limit(pageSize + 1));
    for (const doc of rows.docs)
      ranked.push({
        id: doc.id,
        millis: instantMillis(rank(doc.data())),
        item: map(doc.data(), doc.id),
      });
  }
  ranked.sort(
    (a, b) => b.millis - a.millis || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  const page = ranked.slice(0, pageSize);
  return {
    items: page.map((row) => row.item),
    nextCursor: ranked.length > pageSize ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export const listDeliveryDiagnostics = readCommand(
  (data) => {
    keys(data, ["orgId", "failureCursor", "acknowledgementCursor", "pageSize"]);
    const pageSize = data.pageSize ?? 25;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50)
      invalid("pageSize must be 1 through 50.");
    return {
      orgId: id(data.orgId, "orgId"),
      pageSize,
      failureCursor:
        data.failureCursor == null ? null : id(data.failureCursor, "failureCursor"),
      acknowledgementCursor:
        data.acknowledgementCursor == null
          ? null
          : id(data.acknowledgementCursor, "acknowledgementCursor"),
    };
  },
  async (tx, data, uid) => {
    const scope = await staffScope(tx, data.orgId, uid);
    if (
      scope.organization.features?.organizationV2 !== true ||
      scope.organization.status !== "active"
    )
      denied();
    const programIds = scope.admin ? null : (scope.programIds as string[]);
    if (programIds && programIds.length > 20) {
      throw new HttpsError(
        "resource-exhausted",
        "Select a narrower program scope for delivery diagnostics.",
      );
    }
    if (programIds && !programIds.length) {
      return {
        failures: { items: [], nextCursor: null },
        unacknowledged: { items: [], nextCursor: null },
      };
    }
    const failures = await readMergedPage(
      tx,
      (group) => failureQuery(data.orgId, group),
      programIds,
      data.orgId,
      "deliveryIssues",
      data.failureCursor,
      data.pageSize,
      (row) => row.updatedAt,
      (row, issueId) => ({
        id: issueId,
        channel: row.channel ?? "unknown",
        status: row.status,
        failureCode: row.failureCode ?? null,
        sourceType: row.sourceType ?? null,
        sourceId: row.sourceId ?? null,
        templateKey: row.templateKey ?? null,
        updatedAt: row.updatedAt ?? null,
      }),
    );
    const unacknowledged = await readMergedPage(
      tx,
      (group) => acknowledgementQuery(data.orgId, group),
      programIds,
      data.orgId,
      "criticalUpdates",
      data.acknowledgementCursor,
      data.pageSize,
      (row) => row.createdAt,
      (row, updateId) => ({
        id: updateId,
        title: row.title ?? "Team update",
        sourceType: row.sourceType ?? null,
        sourceId: row.sourceId ?? null,
        sourceRevision: row.sourceRevision ?? null,
        templateKey: row.templateKey ?? null,
        createdAt: row.createdAt ?? null,
      }),
    );
    return { failures, unacknowledged };
  },
);
