import { FieldPath, FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { command, Data, id, invalid, keys, optional } from "../commandSupport";
import { denied } from "../operations/access";
import { fingerprint } from "../operations/requests";
import { readCommand } from "../participants/policy";
import {
  authorizeConversation,
  BLOCK_LIMIT,
  blockFilterApplies,
  blockQuery,
  conversationMessageVisible,
  membership,
  organizationOf,
  supervisorUids,
  transactionReader,
} from "./conversations";

const SCOPES = ["organization", "division", "team", "event"] as const;
export const REPORT_REASONS = ["harassment", "inappropriate", "spam", "safety", "other"] as const;
const RESOLUTIONS = ["dismissed", "removed"] as const;
type ScopeType = (typeof SCOPES)[number];

function scopeInput(data: Data) {
  if (typeof data.scopeType !== "string" || !SCOPES.includes(data.scopeType as ScopeType)) invalid("Invalid scopeType.");
  return { orgId: id(data.orgId, "orgId"), scopeType: data.scopeType as ScopeType, scopeId: id(data.scopeId, "scopeId") };
}
function pageInput(data: Data) {
  const pageSize = data.pageSize ?? 25;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50) invalid("pageSize must be 1 through 50.");
  return { pageSize, cursor: data.cursor == null ? null : id(data.cursor, "cursor") };
}
function messageRef(orgId: string, conversationId: string, messageId: string) {
  return getFirestore().doc(`organizations/${orgId}/conversations/${conversationId}/messages/${messageId}`);
}
function reportsOf(orgId: string) {
  return getFirestore().collection(`organizations/${orgId}/conversationReports`);
}
/** Program staff moderate their programs; organization announcements belong to every staff member, unassigned channels to admins. */
function programKey(scopeType: ScopeType, programId: string | null) {
  if (scopeType === "organization") return "organization";
  return programId ?? "unassigned";
}

export const reportConversationMessage = command("reportConversationMessage", (data) => {
  keys(data, ["requestId", "orgId", "scopeType", "scopeId", "messageId", "reason", "note"]);
  if (typeof data.reason !== "string" || !REPORT_REASONS.includes(data.reason as (typeof REPORT_REASONS)[number])) invalid("Choose a report reason.");
  return {
    ...scopeInput(data),
    messageId: id(data.messageId, "messageId"),
    reason: data.reason,
    note: optional(data.note, "note", 500),
    requestId: id(data.requestId, "requestId"),
  };
}, async (tx, payload, uid, _actor, replay) => {
  const decision = await authorizeConversation(tx, payload.orgId, payload.scopeType, payload.scopeId, uid);
  if (!decision.read) denied();
  const ref = messageRef(payload.orgId, decision.conversationId, payload.messageId);
  const message = await tx.get(ref);
  if (!message.exists) throw new HttpsError("not-found", "Message not found.");
  if (!conversationMessageVisible(decision, message.data())) denied();
  if (replay) return replay;
  const row = message.data() ?? {};
  if (row.authorUid === uid) invalid("You cannot report your own message.");
  if (row.tombstoned === true) throw new HttpsError("failed-precondition", "This message was already removed.");
  const reportId = fingerprint({ kind: "conversationReport", orgId: payload.orgId, conversationId: decision.conversationId, messageId: payload.messageId, reporterUid: uid });
  const reportRef = reportsOf(payload.orgId).doc(reportId);
  const existing = await tx.get(reportRef);
  if (existing.exists) return { id: reportId, status: existing.data()?.status ?? "open", duplicate: true };
  tx.create(reportRef, {
    schemaVersion: 2,
    orgId: payload.orgId,
    conversationId: decision.conversationId,
    scopeType: payload.scopeType,
    scopeId: payload.scopeId,
    programKey: programKey(payload.scopeType, decision.programId),
    messageId: payload.messageId,
    authorUid: typeof row.authorUid === "string" ? row.authorUid : null,
    reporterUid: uid,
    reason: payload.reason,
    note: payload.note,
    // Kept until resolution so an edit after the report cannot erase the evidence.
    reportedBody: typeof row.body === "string" ? row.body : null,
    reportedRevision: row.revision ?? 0,
    status: "open",
    revision: 0,
    idempotencyKey: payload.requestId,
    createdAt: Timestamp.now(),
  });
  return { id: reportId, status: "open", duplicate: false };
});

export const listConversationReports = readCommand((data) => {
  keys(data, ["orgId", "pageSize", "cursor"]);
  return { orgId: id(data.orgId, "orgId"), ...pageInput(data) };
}, async (tx, payload, uid) => {
  await organizationOf(tx, payload.orgId);
  const member = await membership(tx, payload.orgId, uid);
  if (!member.staff) denied();
  const reports = reportsOf(payload.orgId);
  let query = reports.where("status", "==", "open");
  if (!member.admin) query = query.where("programKey", "in", ["organization", ...member.programIds.slice(0, 29)]);
  query = query.orderBy("createdAt", "desc").orderBy(FieldPath.documentId(), "desc").limit(payload.pageSize + 1);
  if (payload.cursor) {
    const cursor = await tx.get(reports.doc(payload.cursor));
    if (!cursor.exists) invalid("Invalid cursor.");
    query = query.startAfter(cursor);
  }
  const rows = await tx.get(query);
  const page = rows.docs.slice(0, payload.pageSize);
  const messages = page.length ? await tx.getAll(...page.map((doc) => messageRef(payload.orgId, doc.get("conversationId"), doc.get("messageId")))) : [];
  return {
    items: page.map((doc, index) => {
      const row = doc.data();
      const current = messages[index]?.data();
      return {
        id: doc.id,
        scopeType: row.scopeType,
        scopeId: row.scopeId,
        messageId: row.messageId,
        authorUid: row.authorUid ?? null,
        reporterUid: row.reporterUid ?? null,
        reason: row.reason,
        note: row.note ?? null,
        reportedBody: row.reportedBody ?? null,
        messageRemoved: !current || current.tombstoned === true,
        editedSinceReport: !!current && (current.revision ?? 0) !== (row.reportedRevision ?? 0) && current.tombstoned !== true,
        createdAt: row.createdAt,
      };
    }),
    nextCursor: rows.size > page.length ? page[page.length - 1]?.id ?? null : null,
  };
});

export const resolveConversationReport = command("resolveConversationReport", (data) => {
  keys(data, ["requestId", "orgId", "reportId", "resolution"]);
  if (typeof data.resolution !== "string" || !RESOLUTIONS.includes(data.resolution as (typeof RESOLUTIONS)[number])) invalid("Invalid resolution.");
  return { orgId: id(data.orgId, "orgId"), reportId: id(data.reportId, "reportId"), resolution: data.resolution, requestId: id(data.requestId, "requestId") };
}, async (tx, payload, uid, _actor, replay) => {
  const reportRef = reportsOf(payload.orgId).doc(payload.reportId);
  const report = (await tx.get(reportRef)).data();
  if (!report || report.orgId !== payload.orgId) denied();
  const decision = await authorizeConversation(tx, payload.orgId, report!.scopeType, report!.scopeId, uid);
  if (!decision.moderate) denied();
  if (replay) return replay;
  if (report!.status !== "open") return { id: payload.reportId, status: report!.status };
  const related = [reportRef];
  if (payload.resolution === "removed") {
    const message = (await tx.get(messageRef(payload.orgId, report!.conversationId, report!.messageId))).data();
    if (message && message.tombstoned !== true) {
      throw new HttpsError("failed-precondition", "Remove the message before closing the report.", { domainCode: "MESSAGE_NOT_REMOVED" });
    }
    // Removing the message settles every open report about it.
    const others = await tx.get(reportsOf(payload.orgId).where("messageId", "==", report!.messageId).where("status", "==", "open").limit(50));
    for (const doc of others.docs) if (doc.id !== payload.reportId && doc.get("conversationId") === report!.conversationId) related.push(doc.ref);
  }
  const now = Timestamp.now();
  for (const ref of related) {
    tx.update(ref, {
      status: payload.resolution,
      resolvedBy: uid,
      resolvedAt: now,
      reportedBody: FieldValue.delete(),
      revision: FieldValue.increment(1),
    });
  }
  return { id: payload.reportId, status: payload.resolution };
});

export const blockConversationMember = command("blockConversationMember", (data) => {
  keys(data, ["requestId", "orgId", "scopeType", "scopeId", "messageId"]);
  return { ...scopeInput(data), messageId: id(data.messageId, "messageId"), requestId: id(data.requestId, "requestId") };
}, async (tx, payload, uid, _actor, replay) => {
  const decision = await authorizeConversation(tx, payload.orgId, payload.scopeType, payload.scopeId, uid);
  if (!decision.read) denied();
  if (!blockFilterApplies(decision)) {
    throw new HttpsError("failed-precondition", "Staff and coaches moderate this channel instead of blocking.", { domainCode: "BLOCK_NOT_AVAILABLE" });
  }
  const message = await tx.get(messageRef(payload.orgId, decision.conversationId, payload.messageId));
  if (!message.exists) throw new HttpsError("not-found", "Message not found.");
  if (!conversationMessageVisible(decision, message.data())) denied();
  if (replay) return replay;
  const blockedUid = message.data()?.authorUid;
  if (typeof blockedUid !== "string") throw new HttpsError("failed-precondition", "This author cannot be blocked.");
  if (blockedUid === uid) invalid("You cannot block yourself.");
  const reader = transactionReader(tx);
  if ((await supervisorUids(reader, payload.orgId, decision.teamIds, [blockedUid])).size) {
    throw new HttpsError("failed-precondition", "Staff and coaches cannot be blocked. Report the message instead.", { domainCode: "BLOCK_NOT_ALLOWED" });
  }
  const blockId = fingerprint({ kind: "userBlock", orgId: payload.orgId, blockerUid: uid, blockedUid });
  const ref = getFirestore().doc(`organizations/${payload.orgId}/userBlocks/${blockId}`);
  const [existing, current] = await Promise.all([tx.get(ref), reader.query(blockQuery(payload.orgId, uid))]);
  if (existing.exists) return { id: blockId, blocked: true };
  if (current.size >= BLOCK_LIMIT) throw new HttpsError("resource-exhausted", "Unblock someone before blocking another member.");
  tx.create(ref, {
    schemaVersion: 2,
    orgId: payload.orgId,
    blockerUid: uid,
    blockedUid,
    status: "active",
    scopeType: payload.scopeType,
    scopeId: payload.scopeId,
    createdAt: Timestamp.now(),
  });
  return { id: blockId, blocked: true };
});

export const unblockConversationMember = command("unblockConversationMember", (data) => {
  keys(data, ["requestId", "orgId", "blockId"]);
  return { orgId: id(data.orgId, "orgId"), blockId: id(data.blockId, "blockId"), requestId: id(data.requestId, "requestId") };
}, async (tx, payload, uid, _actor, replay) => {
  const ref = getFirestore().doc(`organizations/${payload.orgId}/userBlocks/${payload.blockId}`);
  const block = (await tx.get(ref)).data();
  if (replay) return replay;
  if (!block) return { id: payload.blockId, blocked: false };
  if (block.blockerUid !== uid || block.orgId !== payload.orgId) denied();
  tx.delete(ref);
  return { id: payload.blockId, blocked: false };
});

export const listConversationBlocks = readCommand((data) => {
  keys(data, ["orgId"]);
  return { orgId: id(data.orgId, "orgId") };
}, async (tx, payload, uid) => {
  const rows = await tx.get(blockQuery(payload.orgId, uid));
  return {
    // Blocked identities stay server-side; the list names where the block started.
    items: rows.docs.filter((doc) => doc.get("status") === "active").map((doc) => ({
      id: doc.id,
      scopeType: doc.get("scopeType"),
      scopeId: doc.get("scopeId"),
      createdAt: doc.get("createdAt"),
    })),
  };
});
