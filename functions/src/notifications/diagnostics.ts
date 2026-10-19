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
async function readPage(
  tx: FirebaseFirestore.Transaction,
  query: Query,
  orgId: string,
  collection: "deliveryIssues" | "criticalUpdates",
  cursor: string | null,
  pageSize: number,
  map: (row: Data, id: string) => Data,
) {
  if (cursor) {
    const snapshot = await tx.get(
      getFirestore().doc(`organizations/${orgId}/${collection}/${cursor}`),
    );
    if (!snapshot.exists) invalid("Invalid cursor.");
    query = query.startAfter(snapshot);
  }
  const rows = await tx.get(query.limit(pageSize + 1));
  return {
    items: rows.docs.slice(0, pageSize).map((doc) => map(doc.data(), doc.id)),
    nextCursor: rows.size > pageSize ? rows.docs[pageSize - 1].id : null,
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
    if (programIds && programIds.length > 10) {
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
    const failures = await readPage(
      tx,
      failureQuery(data.orgId, programIds),
      data.orgId,
      "deliveryIssues",
      data.failureCursor,
      data.pageSize,
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
    const unacknowledged = await readPage(
      tx,
      acknowledgementQuery(data.orgId, programIds),
      data.orgId,
      "criticalUpdates",
      data.acknowledgementCursor,
      data.pageSize,
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
