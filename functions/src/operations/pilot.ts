import { FieldPath, getFirestore, Timestamp } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { command, Data, id, invalid, keys, object, wire } from "../commandSupport";
import { ATTACHMENT_MAX_BYTES } from "../communications/attachmentScan";
import { audit } from "../organizations/commands";
import { denied, staffScope } from "./access";
import { availableUser } from "../participants/policy";

/** Keep this literal aligned with shared/pilot.ts. */
export const PILOT_ROLLBACK_CONFIRM = "DISABLE_PHASE2_WRITERS";
export const PILOT_WRITER_FLAGS = [
  "scheduler",
  "attendance",
  "locationAssistance",
  "conversations",
  "attachments",
  "rsvpReminders",
  "notificationInboxFake",
  "notificationPush",
  "notificationEmailFallback",
] as const;
export const PILOT_READ_FLAGS = ["organizationV2", "adminWorkspace", "households"] as const;
export const PILOT_STUCK_AFTER_MS = 10 * 60 * 1000;
export const PILOT_FUNCTION_MEMORY = "512MiB";
const IN_FLIGHT = ["staging", "promoting", "verifying"] as const;
const ATTACHMENT_STATES = ["pending", "uploading", "quarantined", "canonicalizing", "rejected", "ready"] as const;
const SAMPLE = 100;

function adminScope(scope: Awaited<ReturnType<typeof staffScope>>) {
  if (
    scope.organization.features?.organizationV2 !== true ||
    scope.organization.status !== "active" ||
    scope.admin !== true
  ) denied();
}

function scannerMode(value: unknown): string {
  if (value == null || value === "") return "content";
  if (value === "content" || value === "unavailable" || value === "external") return value;
  return "unknown";
}

function ageMinutes(updatedAt: { toMillis?: () => number } | null | undefined, nowMs: number) {
  const millis = updatedAt?.toMillis?.();
  if (typeof millis !== "number" || !Number.isFinite(millis)) return PILOT_STUCK_AFTER_MS / 60000;
  return Math.floor(Math.max(0, nowMs - millis) / 60000);
}

export const listPilotOperations = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to continue.");
  const body = object(request.data);
  keys(body, ["orgId"]);
  const orgId = id(body.orgId, "orgId");
  const db = getFirestore();
  // Authorize inside one small transaction. Count queries stay outside it:
  // six 100-row samples plus rejections would exceed the 500-document transaction limit.
  const scope = await db.runTransaction(async (tx) => {
    await availableUser(tx, uid);
    const loaded = await staffScope(tx, orgId, uid);
    adminScope(loaded);
    return {
      features: loaded.organization.features ?? {},
      youthChannels: loaded.organization.policies?.youthChannels,
    };
  });
  const nowMs = Date.now();
  const flags = [...PILOT_READ_FLAGS, ...PILOT_WRITER_FLAGS].map((name) => ({
    name,
    enabled: scope.features[name] === true,
  }));
  const stuckSnap = await db.collection(`organizations/${orgId}/scheduleOperations`)
    .where("state", "in", [...IN_FLIGHT])
    .orderBy("updatedAt", "asc")
    .limit(25)
    .get();
  const stuckOperations = stuckSnap.docs.flatMap((doc) => {
    const age = ageMinutes(doc.data().updatedAt, nowMs);
    if (age < PILOT_STUCK_AFTER_MS / 60000) return [];
    return [{ id: doc.id, state: String(doc.data().state), ageMinutes: age }];
  });
  let attachmentsTruncated = false;
  const counts = {} as Record<(typeof ATTACHMENT_STATES)[number], number>;
  for (const state of ATTACHMENT_STATES) {
    const snap = await db.collection(`organizations/${orgId}/attachments`).where("state", "==", state).limit(SAMPLE + 1).get();
    if (snap.size > SAMPLE) attachmentsTruncated = true;
    counts[state] = Math.min(snap.size, SAMPLE);
  }
  const rejected = await db.collection(`organizations/${orgId}/attachments`).where("state", "==", "rejected").limit(SAMPLE + 1).get();
  const rejectionCounts = new Map<string, number>();
  for (const doc of rejected.docs.slice(0, SAMPLE)) {
    const code = doc.data().rejectionCode;
    const name = typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "UNKNOWN";
    rejectionCounts.set(name, (rejectionCounts.get(name) ?? 0) + 1);
  }
  const scannerDoc = await db.doc("platformConfig/attachmentScanner").get();
  const externalUrl = process.env.ATTACHMENT_SCANNER_URL;
  if (process.env.FUNCTIONS_EMULATOR === "true") {
    const gate = await db.doc("platformConfig/pilotListGate").get();
    const until = gate.data()?.holdUntilMs;
    if (typeof until === "number" && until > Date.now()) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(until - Date.now(), 5000)));
    }
  }
  await db.runTransaction(async (tx) => {
    await availableUser(tx, uid);
    const loaded = await staffScope(tx, orgId, uid);
    adminScope(loaded);
  });
  return wire({
    flags,
    youthChannels: scope.youthChannels === "approved" ? "approved" : "closed",
    stuckOperations,
    attachments: { ...counts, truncated: attachmentsTruncated },
    rejections: [...rejectionCounts.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => a.code < b.code ? -1 : 1),
    rejectionsTruncated: rejected.size > SAMPLE,
    scanner: {
      mode: scannerMode(scannerDoc.data()?.mode),
      externalConfigured: typeof externalUrl === "string" && externalUrl.startsWith("https://"),
    },
    budgets: {
      attachmentMaxBytes: ATTACHMENT_MAX_BYTES,
      functionMemory: PILOT_FUNCTION_MEMORY,
      stuckAfterMinutes: PILOT_STUCK_AFTER_MS / 60000,
    },
  });
});

export const applyPilotRollback = command("applyPilotRollback", (data) => {
  keys(data, ["requestId", "orgId", "confirm"]);
  if (data.confirm !== PILOT_ROLLBACK_CONFIRM) invalid("Confirm the pilot rollback before disabling writers.");
  return {
    orgId: id(data.orgId, "orgId"),
    confirm: PILOT_ROLLBACK_CONFIRM,
    requestId: id(data.requestId, "requestId"),
  };
}, async (tx, payload, uid, _actor, replay) => {
  const scope = await staffScope(tx, payload.orgId, uid);
  adminScope(scope);
  if (replay) return replay;
  const db = getFirestore();
  const lock = (await tx.get(db.doc(`organizations/${payload.orgId}/schedulingLock/current`))).data();
  const lockedId = typeof lock?.operationId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(lock.operationId)
    ? lock.operationId
    : null;
  const lockedSnap = lockedId
    ? await tx.get(db.doc(`organizations/${payload.orgId}/scheduleOperations/${lockedId}`))
    : null;
  const locked = lockedSnap?.exists && (IN_FLIGHT as readonly string[]).includes(String(lockedSnap.data()?.state))
    ? lockedSnap
    : null;
  const snap = await tx.get(
    db.collection(`organizations/${payload.orgId}/scheduleOperations`)
      .where("state", "in", [...IN_FLIGHT])
      .orderBy(FieldPath.documentId())
      .limit(21),
  );
  const page: FirebaseFirestore.DocumentSnapshot[] = [];
  if (locked) page.push(locked);
  for (const doc of snap.docs) {
    if (page.length >= 20) break;
    if (locked && doc.id === locked.id) continue;
    page.push(doc);
  }
  const chosen = new Set(page.map((doc) => doc.id));
  const now = Timestamp.now();
  const patch: Data = { revision: (scope.organization.revision ?? 0) + 1, updatedAt: now };
  for (const flag of PILOT_WRITER_FLAGS) patch[`features.${flag}`] = false;
  tx.update(db.doc(`organizations/${payload.orgId}`), patch);
  const quarantinedOperationIds: string[] = [];
  for (const doc of page) {
    tx.update(doc.ref, { state: "quarantined", revision: ((doc.data()?.revision as number | undefined) ?? 0) + 1, updatedAt: now });
    quarantinedOperationIds.push(doc.id);
  }
  audit(tx, payload.orgId, uid, "pilotRollback", payload.requestId, patch.revision);
  return {
    flagsDisabled: [...PILOT_WRITER_FLAGS],
    quarantinedOperationIds,
    truncated: snap.docs.some((doc) => !chosen.has(doc.id)),
  };
});
