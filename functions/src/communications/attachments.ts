import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp, Transaction } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import { defineSecret } from "firebase-functions/params";
import { accountAvailable } from "../accountAccess";
import { Data, id, invalid, keys, object, wire } from "../commandSupport";
import { cacheDocumentReads } from "../operations/reads";
import { denied } from "../operations/access";
import { fingerprint, receiptId } from "../operations/requests";
import { authorizeConversation, type ConversationDecision } from "./conversations";
import {
  ATTACHMENT_EXPIRY_SECONDS,
  ATTACHMENT_LIMIT,
  ATTACHMENT_MAX_BYTES,
  DEMO_ATTACHMENT_UPLOAD_KEY,
  attachmentFileName,
  configuredAttachmentBucket,
  developmentScanner,
  readUploadGrant,
  reviewAttachment,
  sha256,
  signUploadGrant,
  uploadObjectPath,
  type AttachmentReview,
  type UploadGrant,
} from "./attachmentScan";

const uploadKey = defineSecret("ATTACHMENT_UPLOAD_KEY");
const SCOPES = ["organization", "division", "team", "event"] as const;
type ScopeType = (typeof SCOPES)[number];

function emulatorDemo() {
  return process.env.FUNCTIONS_EMULATOR === "true" && process.env.GCLOUD_PROJECT === "demo-team-hangout";
}
function signingKey(): string {
  if (emulatorDemo()) return DEMO_ATTACHMENT_UPLOAD_KEY;
  const value = uploadKey.value();
  if (typeof value !== "string" || value.length < 32) {
    throw new HttpsError("failed-precondition", "Attachment upload signing is not configured.");
  }
  return value;
}
const callableOptions = emulatorDemo() ? {} : { secrets: [uploadKey] };
const httpOptions = emulatorDemo()
  ? { cors: false as const, timeoutSeconds: 60, memory: "512MiB" as const }
  : { cors: false as const, timeoutSeconds: 60, memory: "512MiB" as const, secrets: [uploadKey] };

function scopeType(value: unknown): ScopeType {
  if (value === "direct") {
    throw new HttpsError("failed-precondition", "Direct messages are not available.", { domainCode: "YOUTH_POLICY" });
  }
  if (typeof value !== "string" || !SCOPES.includes(value as ScopeType)) invalid("Invalid scopeType.");
  return value as ScopeType;
}
function scopeInput(data: Data) {
  return { orgId: id(data.orgId, "orgId"), scopeType: scopeType(data.scopeType), scopeId: id(data.scopeId, "scopeId") };
}
function declaredBytes(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > ATTACHMENT_MAX_BYTES) {
    throw new HttpsError("invalid-argument", "Attachments must be 10 MB or smaller.", { domainCode: "OVERSIZED" });
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return invalid("Invalid declaredBytes.");
  return value;
}
function fileName(value: unknown): string {
  const named = attachmentFileName(value);
  if ("error" in named) return invalid("Use a JPEG, PNG, or PDF file name.");
  return named.name;
}
function assertPost(decision: ConversationDecision) {
  if (!decision.attachments) {
    throw new HttpsError("failed-precondition", "Attachments are not enabled for this organization.", { domainCode: "FEATURE_DISABLED" });
  }
  if (decision.youthBlocked) {
    throw new HttpsError("failed-precondition", "Youth channels stay closed until the organization approves the policy.", { domainCode: "YOUTH_POLICY" });
  }
  if (!decision.post) denied();
}
function assertRead(decision: ConversationDecision) {
  if (!decision.attachments) {
    throw new HttpsError("failed-precondition", "Attachments are not enabled for this organization.", { domainCode: "FEATURE_DISABLED" });
  }
  if (!decision.read) denied();
}
function transportUrl(): string {
  const project = process.env.GCLOUD_PROJECT ?? "";
  if (!/^[a-z0-9-]+$/.test(project)) throw new HttpsError("failed-precondition", "Attachment upload signing is not configured.");
  if (process.env.FUNCTIONS_EMULATOR === "true") return `http://127.0.0.1:5001/${project}/us-central1/attachmentTransport`;
  return `https://us-central1-${project}.cloudfunctions.net/attachmentTransport`;
}
function bucket() {
  const name = configuredAttachmentBucket(getStorage().app.options.storageBucket);
  if (!name) throw new HttpsError("failed-precondition", "Attachment storage is not configured.");
  return getStorage().bucket(name);
}
function attachmentRef(orgId: string, attachmentId: string) {
  return getFirestore().doc(`organizations/${orgId}/attachments/${attachmentId}`);
}
function slotRef(orgId: string, conversationId: string, uid: string) {
  return getFirestore().doc(`organizations/${orgId}/attachmentSlots/${fingerprint({ kind: "attachmentSlot", orgId, conversationId, uid })}`);
}
function scanRejected(code: string) {
  return { scanner: "fake" as const, verdict: "rejected" as const, code };
}
function view(attachmentId: string, row: Data) {
  return {
    id: attachmentId,
    state: row.state === "ready" ? "ready" : "rejected",
    detectedType: row.detectedType ?? null,
    byteLength: row.actualBytes ?? 0,
    sha256: row.sha256 ?? null,
    fileName: row.fileName ?? null,
    scan: row.scan ?? null,
    rejectionCode: row.rejectionCode ?? null,
  };
}
function storedScope(value: unknown): ScopeType | null {
  return typeof value === "string" && SCOPES.includes(value as ScopeType) ? value as ScopeType : null;
}

async function reserve(tx: Transaction, orgId: string, conversationId: string, uid: string, attachmentId: string, now: Timestamp) {
  const ref = slotRef(orgId, conversationId, uid);
  const slot = (await tx.get(ref)).data();
  const activeIds = Array.isArray(slot?.activeIds) ? slot.activeIds.filter((item: unknown): item is string => typeof item === "string") : [];
  if (activeIds.length > ATTACHMENT_LIMIT) {
    throw new HttpsError("resource-exhausted", "Too many attachment reservations.");
  }
  const docs = activeIds.length ? await tx.getAll(...activeIds.map((item) => attachmentRef(orgId, item))) : [];
  const kept: string[] = [];
  for (const doc of docs) {
    const row = doc.data();
    if (!row || row.ownerUid !== uid || row.conversationId !== conversationId) continue;
    if ((row.state === "pending" || row.state === "uploading") && row.expiresAt?.toMillis?.() <= now.toMillis()) {
      tx.update(doc.ref, { state: "rejected", rejectionCode: "EXPIRED", scan: scanRejected("EXPIRED"), updatedAt: now });
      continue;
    }
    if (row.state === "pending" || row.state === "uploading" || row.state === "quarantined" || row.state === "ready") kept.push(doc.id);
  }
  if (kept.length >= ATTACHMENT_LIMIT) {
    throw new HttpsError("failed-precondition", "A conversation can hold 3 attachments.", { domainCode: "ATTACHMENT_LIMIT" });
  }
  tx.set(ref, { schemaVersion: 2, orgId, ownerUid: uid, conversationId, activeIds: [...kept, attachmentId], updatedAt: now }, { merge: true });
}

function dropActive(tx: Transaction, orgId: string, conversationId: string, uid: string, attachmentId: string, slot: Data | undefined) {
  const activeIds = Array.isArray(slot?.activeIds) ? slot.activeIds.filter((item: unknown) => item !== attachmentId && typeof item === "string") : [];
  tx.set(slotRef(orgId, conversationId, uid), { schemaVersion: 2, orgId, ownerUid: uid, conversationId, activeIds, updatedAt: Timestamp.now() }, { merge: true });
}

export const createAttachmentUpload = onCall(callableOptions, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to continue.");
  const data = object(request.data);
  keys(data, ["requestId", "orgId", "scopeType", "scopeId", "fileName", "declaredBytes"]);
  const requestId = id(data.requestId, "requestId");
  const payload = { ...scopeInput(data), requestId, fileName: fileName(data.fileName), declaredBytes: declaredBytes(data.declaredBytes) };
  const payloadFingerprint = fingerprint(payload);
  const db = getFirestore();
  const receipt = db.doc(`commandRequests/${receiptId(uid, "createAttachmentUpload", requestId, payload.orgId)}`);
  return db.runTransaction(async (tx) => {
    tx = cacheDocumentReads(tx);
    await accountAvailable(tx, uid);
    const decision = await authorizeConversation(tx, payload.orgId, payload.scopeType, payload.scopeId, uid);
    assertPost(decision);
    const previous = await tx.get(receipt);
    if (previous.exists && previous.data()?.fingerprint !== payloadFingerprint) {
      throw new HttpsError("already-exists", "This request ID was used for another change.", { domainCode: "REQUEST_ID_REUSED" });
    }
    if (previous.exists) return wire(previous.data()?.result);
    const attachmentId = fingerprint({ kind: "attachment", orgId: payload.orgId, conversationId: decision.conversationId, requestId, ownerUid: uid });
    const nowMs = Date.now();
    const exp = Math.floor(nowMs / 1000) + ATTACHMENT_EXPIRY_SECONDS;
    const now = Timestamp.fromMillis(exp * 1000 - ATTACHMENT_EXPIRY_SECONDS * 1000);
    const expiresAt = Timestamp.fromMillis(exp * 1000);
    const path = uploadObjectPath(payload.orgId, attachmentId);
    await reserve(tx, payload.orgId, decision.conversationId, uid, attachmentId, now);
    tx.create(attachmentRef(payload.orgId, attachmentId), {
      schemaVersion: 2,
      orgId: payload.orgId,
      conversationId: decision.conversationId,
      scopeType: payload.scopeType,
      scopeId: payload.scopeId,
      ownerUid: uid,
      fileName: payload.fileName,
      declaredBytes: payload.declaredBytes,
      actualBytes: null,
      detectedType: null,
      sha256: null,
      state: "pending",
      scan: null,
      objectPath: path,
      generation: 1,
      expiresAt,
      rejectionCode: null,
      messageId: null,
      createdAt: now,
      updatedAt: now,
    });
    const token = signUploadGrant({
      v: 1, exp, attachmentId, uid, orgId: payload.orgId, bytes: payload.declaredBytes, path,
    }, signingKey());
    const result = { id: attachmentId, uploadUrl: transportUrl(), token, expiresAt: expiresAt.toDate().toISOString(), maxBytes: payload.declaredBytes, state: "pending" };
    tx.create(receipt, { uid, operation: "createAttachmentUpload", fingerprint: payloadFingerprint, result, createdAt: now });
    return result;
  });
});

function end(res: Response, status: number, message: string) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(status).type("text/plain; charset=utf-8").end(message);
}
function applyDevCors(req: Request, res: Response) {
  if (process.env.FUNCTIONS_EMULATOR !== "true") return;
  const origin = req.header("origin");
  if (!origin || !/^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/.test(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Org-Id, X-Scope-Type, X-Scope-Id, X-Attachment-Id");
  res.setHeader("Access-Control-Max-Age", "600");
}
function httpFailure(res: Response, error: unknown, download: boolean) {
  if (res.headersSent) return;
  if (error instanceof HttpsError && error.code === "unauthenticated") return end(res, 401, "Sign in to continue.");
  if (download) return end(res, 404, "This file is unavailable.");
  const domain = error instanceof HttpsError && error.details && typeof error.details === "object" ? (error.details as { domainCode?: string }).domainCode : undefined;
  if (domain === "EXPIRED") return end(res, 410, "This upload expired.");
  if (domain === "OVERSIZED") return end(res, 413, "This file is larger than 10 MB.");
  if (domain === "SIZE_MISMATCH") return end(res, 413, "This file does not match the reserved upload.");
  if (error instanceof HttpsError && error.code === "permission-denied") return end(res, 403, "This upload is unavailable.");
  if (domain === "YOUTH_POLICY" || domain === "FEATURE_DISABLED") return end(res, 403, "This upload is unavailable.");
  return end(res, 409, "This upload is unavailable.");
}

async function rejectGrant(grant: UploadGrant, code: "EXPIRED" | "OVERSIZED" | "SIZE_MISMATCH") {
  const db = getFirestore();
  const ref = attachmentRef(grant.orgId, grant.attachmentId);
  await db.runTransaction(async (tx) => {
    tx = cacheDocumentReads(tx);
    const snap = await tx.get(ref);
    const row = snap.data();
    if (!row || row.ownerUid !== grant.uid || row.objectPath !== grant.path || row.orgId !== grant.orgId) return;
    if (row.state === "ready" || row.state === "quarantined") return;
    if (row.state === "rejected") return;
    const slot = (await tx.get(slotRef(grant.orgId, row.conversationId, grant.uid))).data();
    tx.update(ref, { state: "rejected", rejectionCode: code, scan: scanRejected(code), updatedAt: Timestamp.now() });
    dropActive(tx, grant.orgId, row.conversationId, grant.uid, grant.attachmentId, slot);
  });
}

async function receiveUpload(grant: UploadGrant, bytes: Buffer) {
  const hash = sha256(bytes);
  const db = getFirestore();
  const ref = attachmentRef(grant.orgId, grant.attachmentId);
  const claim = await db.runTransaction(async (tx) => {
    tx = cacheDocumentReads(tx);
    const snap = await tx.get(ref);
    const row = snap.data();
    const scope = storedScope(row?.scopeType);
    if (!row || !scope || row.ownerUid !== grant.uid || row.objectPath !== grant.path || row.declaredBytes !== grant.bytes || row.orgId !== grant.orgId) {
      return "missing" as const;
    }
    if (row.expiresAt.toMillis() <= Date.now()) return "expired" as const;
    const decision = await authorizeConversation(tx, row.orgId, scope, row.scopeId, grant.uid);
    assertPost(decision);
    if (row.conversationId !== decision.conversationId) return "missing" as const;
    if ((row.state === "quarantined" || row.state === "uploading") && row.sha256 === hash) return "resume" as const;
    if (row.state !== "pending") return "conflict" as const;
    tx.update(ref, { state: "uploading", sha256: hash, actualBytes: bytes.length, generation: 1, updatedAt: Timestamp.now() });
    return "claimed" as const;
  });
  if (claim === "missing") throw new HttpsError("permission-denied", "This upload is unavailable.");
  if (claim === "expired") {
    await rejectGrant(grant, "EXPIRED");
    throw new HttpsError("failed-precondition", "This upload expired.", { domainCode: "EXPIRED" });
  }
  if (claim === "conflict") throw new HttpsError("failed-precondition", "This upload is unavailable.");
  await bucket().file(grant.path).save(bytes, { resumable: false, metadata: { contentType: "application/octet-stream" } });
  const finished = await db.runTransaction(async (tx) => {
    tx = cacheDocumentReads(tx);
    const snap = await tx.get(ref);
    const row = snap.data();
    const scope = storedScope(row?.scopeType);
    if (!row || !scope || row.sha256 !== hash || (row.state !== "uploading" && row.state !== "quarantined")) return "conflict" as const;
    if (row.state === "quarantined") return "ok" as const;
    const slot = (await tx.get(slotRef(row.orgId, row.conversationId, row.ownerUid))).data();
    if (row.expiresAt.toMillis() <= Date.now()) {
      tx.update(ref, { state: "rejected", rejectionCode: "EXPIRED", scan: scanRejected("EXPIRED"), updatedAt: Timestamp.now() });
      dropActive(tx, row.orgId, row.conversationId, row.ownerUid, grant.attachmentId, slot);
      return "expired" as const;
    }
    try {
      const decision = await authorizeConversation(tx, row.orgId, scope, row.scopeId, grant.uid);
      assertPost(decision);
    } catch (error) {
      if (!(error instanceof HttpsError)) throw error;
      tx.update(ref, { state: "rejected", rejectionCode: "ACCESS_REVOKED", scan: scanRejected("ACCESS_REVOKED"), updatedAt: Timestamp.now() });
      dropActive(tx, row.orgId, row.conversationId, row.ownerUid, grant.attachmentId, slot);
      return "denied" as const;
    }
    tx.update(ref, { state: "quarantined", updatedAt: Timestamp.now() });
    return "ok" as const;
  });
  if (finished === "expired") {
    await bucket().file(grant.path).delete({ ignoreNotFound: true });
    throw new HttpsError("failed-precondition", "This upload expired.", { domainCode: "EXPIRED" });
  }
  if (finished === "denied") {
    await bucket().file(grant.path).delete({ ignoreNotFound: true });
    throw new HttpsError("permission-denied", "This upload is unavailable.");
  }
  if (finished === "conflict") throw new HttpsError("failed-precondition", "This upload is unavailable.");
}

async function putAttachment(req: Request, res: Response) {
  const header = req.header("authorization") ?? "";
  const match = /^Attachment ([A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})$/.exec(header);
  if (!match) return end(res, 401, "This upload is unavailable.");
  const parsed = readUploadGrant(match[1], signingKey(), Date.now());
  if ("error" in parsed && parsed.error === "invalid") return end(res, 401, "This upload is unavailable.");
  if (!("grant" in parsed)) return end(res, 401, "This upload is unavailable.");
  if ("error" in parsed) {
    await rejectGrant(parsed.grant, "EXPIRED");
    return end(res, 410, "This upload expired.");
  }
  const bytes = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.alloc(0);
  const headerLength = req.header("content-length");
  const announced = headerLength == null || headerLength === "" ? bytes.length : Number(headerLength);
  if (!Number.isInteger(announced) || announced !== parsed.grant.bytes || bytes.length !== parsed.grant.bytes) {
    const oversized = announced > ATTACHMENT_MAX_BYTES || bytes.length > ATTACHMENT_MAX_BYTES;
    await rejectGrant(parsed.grant, oversized ? "OVERSIZED" : "SIZE_MISMATCH");
    return end(res, 413, oversized ? "This file is larger than 10 MB." : "This file does not match the reserved upload.");
  }
  await receiveUpload(parsed.grant, bytes);
  res.setHeader("Cache-Control", "private, no-store");
  res.status(200).json({ state: "quarantined", byteLength: bytes.length });
}

function disposition(name: string) {
  const ascii = name.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120);
  return `attachment; filename="${ascii || "attachment"}"`;
}

async function downloadAttachment(req: Request, res: Response) {
  const header = req.header("authorization") ?? "";
  const match = /^Bearer (\S+)$/.exec(header);
  if (!match) return end(res, 401, "Sign in to continue.");
  const decoded = await getAuth().verifyIdToken(match[1]);
  const orgId = id(req.header("x-org-id"), "orgId");
  const scope = scopeType(req.header("x-scope-type"));
  const scopeId = id(req.header("x-scope-id"), "scopeId");
  const attachmentId = id(req.header("x-attachment-id"), "attachmentId");
  const allowed = await getFirestore().runTransaction(async (tx) => {
    tx = cacheDocumentReads(tx);
    await accountAvailable(tx, decoded.uid);
    const decision = await authorizeConversation(tx, orgId, scope, scopeId, decoded.uid);
    assertRead(decision);
    const snap = await tx.get(attachmentRef(orgId, attachmentId));
    const row = snap.data();
    if (!row || row.orgId !== orgId || row.conversationId !== decision.conversationId || row.state !== "ready" || row.messageId != null) return null;
    if (typeof row.objectPath !== "string" || typeof row.sha256 !== "string" || typeof row.detectedType !== "string") return null;
    return {
      path: row.objectPath,
      sha256: row.sha256,
      detectedType: row.detectedType,
      fileName: typeof row.fileName === "string" ? row.fileName : "attachment",
      byteLength: row.actualBytes,
    };
  });
  if (!allowed) return end(res, 404, "This file is unavailable.");
  const [bytes] = await bucket().file(allowed.path).download();
  if (bytes.length !== allowed.byteLength || sha256(bytes) !== allowed.sha256) return end(res, 404, "This file is unavailable.");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", allowed.detectedType);
  res.setHeader("Content-Disposition", disposition(allowed.fileName));
  res.setHeader("Content-Length", String(bytes.length));
  res.status(200).end(bytes);
}

export const attachmentTransport = onRequest(httpOptions, async (req, res) => {
  applyDevCors(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  try {
    if (req.method === "PUT") return await putAttachment(req, res);
    if (req.method === "GET") return await downloadAttachment(req, res);
    return end(res, 405, "This file is unavailable.");
  } catch (error) {
    httpFailure(res, error, req.method === "GET");
  }
});

function reviewView(attachmentId: string, fileName: string, review: AttachmentReview) {
  return {
    id: attachmentId,
    state: review.state,
    detectedType: review.detectedType,
    byteLength: review.byteLength,
    sha256: review.sha256,
    fileName,
    scan: review.scan,
    rejectionCode: review.state === "rejected" ? review.code : null,
  };
}

export const finalizeAttachment = onCall(callableOptions, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Sign in to continue.");
  const data = object(request.data);
  keys(data, ["requestId", "orgId", "scopeType", "scopeId", "attachmentId"]);
  const requestId = id(data.requestId, "requestId");
  const payload = { ...scopeInput(data), requestId, attachmentId: id(data.attachmentId, "attachmentId") };
  const payloadFingerprint = fingerprint(payload);
  const db = getFirestore();
  const receipt = db.doc(`commandRequests/${receiptId(uid, "finalizeAttachment", requestId, payload.orgId)}`);
  const ref = attachmentRef(payload.orgId, payload.attachmentId);
  const opened = await db.runTransaction(async (tx) => {
    tx = cacheDocumentReads(tx);
    await accountAvailable(tx, uid);
    const decision = await authorizeConversation(tx, payload.orgId, payload.scopeType, payload.scopeId, uid);
    assertPost(decision);
    const previous = await tx.get(receipt);
    if (previous.exists && previous.data()?.fingerprint !== payloadFingerprint) {
      throw new HttpsError("already-exists", "This request ID was used for another change.", { domainCode: "REQUEST_ID_REUSED" });
    }
    if (previous.exists) return { kind: "replay" as const, result: previous.data()?.result };
    const snap = await tx.get(ref);
    const row = snap.data();
    if (!row || row.orgId !== payload.orgId || row.conversationId !== decision.conversationId || row.ownerUid !== uid || row.messageId != null) denied();
    if (row.state === "ready" || row.state === "rejected") return { kind: "terminal" as const, result: view(payload.attachmentId, row) };
    if (row.state !== "quarantined" || typeof row.objectPath !== "string" || typeof row.sha256 !== "string" || typeof row.fileName !== "string") {
      throw new HttpsError("failed-precondition", "Upload the file before finishing it.", { domainCode: "UPLOAD_REQUIRED" });
    }
    return {
      kind: "review" as const,
      path: row.objectPath as string,
      declaredBytes: row.declaredBytes as number,
      sha256: row.sha256 as string,
      fileName: row.fileName as string,
      expiresAtMs: row.expiresAt.toMillis() as number,
    };
  });
  if (opened.kind === "replay") return opened.result;
  let review: AttachmentReview | null = null;
  if (opened.kind === "review") {
    if (opened.expiresAtMs <= Date.now()) {
      review = await reviewAttachment({
        fileName: opened.fileName, declaredBytes: opened.declaredBytes, bytes: Buffer.alloc(0), expiresAtMs: opened.expiresAtMs, nowMs: Date.now(), scanner: developmentScanner,
      });
    } else {
      const downloaded = await bucket().file(opened.path).download().then((parts) => parts[0]).catch(() => Buffer.alloc(0));
      const bytes = Buffer.from(downloaded);
      if (sha256(bytes) !== opened.sha256) {
        review = { state: "rejected", code: "INTEGRITY", detectedType: null, sha256: sha256(bytes), byteLength: bytes.length, scan: scanRejected("INTEGRITY") };
      } else {
        review = await reviewAttachment({
          fileName: opened.fileName, declaredBytes: opened.declaredBytes, bytes, expiresAtMs: opened.expiresAtMs, nowMs: Date.now(), scanner: developmentScanner,
        });
      }
    }
  }
  const result = opened.kind === "terminal" ? opened.result : reviewView(payload.attachmentId, opened.fileName, review!);
  const committed = await db.runTransaction(async (tx) => {
    tx = cacheDocumentReads(tx);
    await accountAvailable(tx, uid);
    const decision = await authorizeConversation(tx, payload.orgId, payload.scopeType, payload.scopeId, uid);
    assertPost(decision);
    const previous = await tx.get(receipt);
    if (previous.exists && previous.data()?.fingerprint !== payloadFingerprint) {
      throw new HttpsError("already-exists", "This request ID was used for another change.", { domainCode: "REQUEST_ID_REUSED" });
    }
    if (previous.exists) return previous.data()?.result;
    const snap = await tx.get(ref);
    const row = snap.data();
    if (!row || row.ownerUid !== uid || row.conversationId !== decision.conversationId) denied();
    if (row.state === "ready" || row.state === "rejected") {
      const current = view(payload.attachmentId, row);
      tx.create(receipt, { uid, operation: "finalizeAttachment", fingerprint: payloadFingerprint, result: current, createdAt: Timestamp.now() });
      return current;
    }
    if (opened.kind !== "review" || row.state !== "quarantined" || row.sha256 !== opened.sha256) {
      throw new HttpsError("failed-precondition", "Upload the file before finishing it.", { domainCode: "UPLOAD_REQUIRED" });
    }
    const slot = (await tx.get(slotRef(payload.orgId, decision.conversationId, uid))).data();
    const now = Timestamp.now();
    if (review!.state === "rejected") {
      tx.update(ref, {
        state: "rejected", rejectionCode: review!.code, detectedType: null, scan: review!.scan, sha256: review!.sha256, actualBytes: review!.byteLength, updatedAt: now,
      });
      dropActive(tx, payload.orgId, decision.conversationId, uid, payload.attachmentId, slot);
    } else {
      tx.update(ref, { state: "ready", detectedType: review!.detectedType, scan: review!.scan, rejectionCode: null, sha256: review!.sha256, actualBytes: review!.byteLength, updatedAt: now });
    }
    tx.create(receipt, { uid, operation: "finalizeAttachment", fingerprint: payloadFingerprint, result, createdAt: now });
    return result;
  });
  if (opened.kind === "review" && review?.state === "rejected") {
    await bucket().file(opened.path).delete({ ignoreNotFound: true });
  }
  return committed;
});
