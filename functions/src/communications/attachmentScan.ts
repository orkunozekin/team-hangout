import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Keep aligned with shared/attachments.ts. Real scanning and metadata stripping are P2.19. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_LIMIT = 3;
export const ATTACHMENT_EXPIRY_SECONDS = 5 * 60;
export const DEMO_ATTACHMENT_UPLOAD_KEY = "demo-attachment-upload-key-v1-do-not-use-live";

export type DetectedType = "image/jpeg" | "image/png" | "application/pdf";
export type AttachmentExtension = "jpg" | "jpeg" | "png" | "pdf";
export type ScanRequest = { bytes: Buffer; detectedType: DetectedType };
export type ScanVerdict = { verdict: "clean" } | { verdict: "rejected"; code: string };
export type AttachmentScanner = (input: ScanRequest) => ScanVerdict | Promise<ScanVerdict>;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EXPECTED: Record<AttachmentExtension, DetectedType> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  pdf: "application/pdf",
};

export function developmentScanner(_input: ScanRequest): ScanVerdict {
  return { verdict: "clean" };
}

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The Admin SDK default bucket. Never invent a legacy appspot name from the project id. */
export function configuredAttachmentBucket(configured: unknown): string | null {
  const name = typeof configured === "string" ? configured.replace(/^gs:\/\//, "") : "";
  if (!/^[a-z0-9][a-z0-9._-]{2,220}$/.test(name) || name.includes("..")) return null;
  return name;
}

const APPROVED_ADMIN_ORIGINS = new Set([
  "https://team-hangout-staging.web.app",
  "https://team-hangout-staging.firebaseapp.com",
  "https://team-hangout-ddf27.web.app",
  "https://team-hangout-ddf27.firebaseapp.com",
]);

/** Echo only an approved admin origin, plus loopback while the emulator is running. */
export function attachmentCorsOrigin(origin: unknown, emulator: boolean): string | null {
  if (typeof origin !== "string" || origin.length === 0 || origin.length > 200) return null;
  if (APPROVED_ADMIN_ORIGINS.has(origin)) return origin;
  if (emulator && /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/.test(origin)) return origin;
  return null;
}

/** A missing object is a durable integrity failure. Timeouts and other storage errors stay retryable. */
export function storageReadFailure(error: unknown): "missing" | "retry" {
  const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code === 404 || code === "404" || code === "ENOENT") return "missing";
  return "retry";
}

export function uploadObjectPath(orgId: string, attachmentId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(orgId) || !/^[A-Za-z0-9_-]+$/.test(attachmentId)) {
    throw new Error("Invalid attachment path.");
  }
  return `quarantine/${orgId}/${attachmentId}/1`;
}

export function attachmentFileName(value: unknown): { name: string; extension: AttachmentExtension } | { error: "invalid" } {
  if (typeof value !== "string") return { error: "invalid" };
  const base = value.split(/[/\\]/).pop() ?? "";
  if (base !== value || base.length < 5 || base.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(base)) {
    return { error: "invalid" };
  }
  const match = /\.(jpg|jpeg|png|pdf)$/i.exec(base);
  if (!match) return { error: "invalid" };
  return { name: base, extension: match[1].toLowerCase() as AttachmentExtension };
}

function unsafe(bytes: Buffer): boolean {
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return true;
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return true;
  if (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21) return true;
  const head = bytes.subarray(0, Math.min(bytes.length, 128)).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<svg") || head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<script") || head.startsWith("<?xml");
}

export function detectAttachment(extension: AttachmentExtension, bytes: Buffer): { type: DetectedType } | { code: "UNSAFE_CONTENT" | "SIGNATURE_MISMATCH" } {
  if (unsafe(bytes)) return { code: "UNSAFE_CONTENT" };
  let detected: DetectedType | null = null;
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) detected = "image/jpeg";
  else if (bytes.length >= PNG.length && bytes.subarray(0, PNG.length).equals(PNG)) detected = "image/png";
  else if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") detected = "application/pdf";
  if (detected == null || detected !== EXPECTED[extension]) return { code: "SIGNATURE_MISMATCH" };
  return { type: detected };
}

export type UploadGrant = {
  v: 1;
  exp: number;
  attachmentId: string;
  uid: string;
  orgId: string;
  bytes: number;
  path: string;
};

function canonical(grant: UploadGrant): Buffer {
  return Buffer.from(JSON.stringify([grant.v, grant.exp, grant.attachmentId, grant.uid, grant.orgId, grant.bytes, grant.path]));
}

export function signUploadGrant(grant: UploadGrant, key: string): string {
  if (grant.v !== 1 || !Number.isSafeInteger(grant.exp) || grant.exp < 0) throw new Error("Invalid upload grant.");
  if (!/^[A-Za-z0-9_-]+$/.test(grant.attachmentId) || !/^[A-Za-z0-9_-]+$/.test(grant.uid) || !/^[A-Za-z0-9_-]+$/.test(grant.orgId)) {
    throw new Error("Invalid upload grant.");
  }
  if (!Number.isSafeInteger(grant.bytes) || grant.bytes < 1 || grant.bytes > ATTACHMENT_MAX_BYTES) throw new Error("Invalid upload grant.");
  if (grant.path !== uploadObjectPath(grant.orgId, grant.attachmentId)) throw new Error("Invalid upload grant.");
  if (key.length < 32) throw new Error("Invalid upload grant.");
  const body = canonical(grant);
  const signature = createHmac("sha256", key).update(body).digest();
  return `${body.toString("base64url")}.${signature.toString("base64url")}`;
}

export function readUploadGrant(token: string, key: string, nowMs: number): { grant: UploadGrant } | { error: "expired"; grant: UploadGrant } | { error: "invalid" } {
  if (key.length < 32 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return { error: "invalid" };
  const [encoded, encodedSignature] = token.split(".");
  const body = Buffer.from(encoded, "base64url");
  const signature = Buffer.from(encodedSignature, "base64url");
  const expected = createHmac("sha256", key).update(body).digest();
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return { error: "invalid" };
  let parsed: unknown;
  try { parsed = JSON.parse(body.toString("utf8")); } catch { return { error: "invalid" }; }
  if (!Array.isArray(parsed) || parsed.length !== 7 || parsed[0] !== 1) return { error: "invalid" };
  const grant: UploadGrant = {
    v: 1,
    exp: parsed[1],
    attachmentId: parsed[2],
    uid: parsed[3],
    orgId: parsed[4],
    bytes: parsed[5],
    path: parsed[6],
  };
  if (!Number.isSafeInteger(grant.exp) || typeof grant.attachmentId !== "string" || typeof grant.uid !== "string" || typeof grant.orgId !== "string" || typeof grant.bytes !== "number" || typeof grant.path !== "string") {
    return { error: "invalid" };
  }
  try { signUploadGrant(grant, key); } catch { return { error: "invalid" }; }
  if (grant.exp * 1000 <= nowMs) return { error: "expired", grant };
  return { grant };
}

export type AttachmentReview =
  | { state: "ready"; detectedType: DetectedType; sha256: string; byteLength: number; scan: { scanner: "fake"; verdict: "clean" } }
  | { state: "rejected"; code: string; detectedType: null; sha256: string; byteLength: number; scan: { scanner: "fake"; verdict: "rejected"; code: string } };

function rejected(code: string, bytes: Buffer): AttachmentReview {
  const safe = /^[A-Z0-9_]{1,40}$/.test(code) ? code : "SCAN_REJECTED";
  return {
    state: "rejected",
    code: safe,
    detectedType: null,
    sha256: sha256(bytes),
    byteLength: bytes.length,
    scan: { scanner: "fake", verdict: "rejected", code: safe },
  };
}

export async function reviewAttachment(input: {
  fileName: string;
  declaredBytes: number;
  bytes: Buffer;
  expiresAtMs: number;
  nowMs: number;
  scanner: AttachmentScanner;
}): Promise<AttachmentReview> {
  const named = attachmentFileName(input.fileName);
  if ("error" in named) return rejected("SIGNATURE_MISMATCH", input.bytes);
  if (input.expiresAtMs <= input.nowMs) return rejected("EXPIRED", input.bytes);
  if (input.declaredBytes > ATTACHMENT_MAX_BYTES || input.bytes.length > ATTACHMENT_MAX_BYTES) return rejected("OVERSIZED", input.bytes);
  if (!Number.isSafeInteger(input.declaredBytes) || input.declaredBytes < 1 || input.bytes.length !== input.declaredBytes) {
    return rejected("SIZE_MISMATCH", input.bytes);
  }
  const detected = detectAttachment(named.extension, input.bytes);
  if ("code" in detected) return rejected(detected.code, input.bytes);
  let verdict: ScanVerdict;
  try { verdict = await input.scanner({ bytes: input.bytes, detectedType: detected.type }); }
  catch { return rejected("SCAN_FAILED", input.bytes); }
  if (verdict.verdict === "rejected") return rejected(verdict.code || "SCAN_REJECTED", input.bytes);
  return {
    state: "ready",
    detectedType: detected.type,
    sha256: sha256(input.bytes),
    byteLength: input.bytes.length,
    scan: { scanner: "fake", verdict: "clean" },
  };
}
