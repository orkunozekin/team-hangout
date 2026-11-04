import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { inflateSync } from "node:zlib";

/** Keep aligned with shared/attachments.ts. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_LIMIT = 3;
export const ATTACHMENT_EXPIRY_SECONDS = 5 * 60;
export const ATTACHMENT_QUARANTINE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEMO_ATTACHMENT_UPLOAD_KEY = "demo-attachment-upload-key-v1-do-not-use-live";

export type DetectedType = "image/jpeg" | "image/png" | "application/pdf";
export type AttachmentExtension = "jpg" | "jpeg" | "png" | "pdf";
export type ScanRequest = { bytes: Buffer; detectedType: DetectedType };
export type ScanVerdict = { verdict: "clean"; bytes?: Buffer } | { verdict: "rejected"; code: string };
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

/** Stripped bytes live beside the upload so a grant replay cannot replace them. */
export function canonicalObjectPath(orgId: string, attachmentId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(orgId) || !/^[A-Za-z0-9_-]+$/.test(attachmentId)) {
    throw new Error("Invalid attachment path.");
  }
  return `quarantine/${orgId}/${attachmentId}/2`;
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
  | { state: "ready"; detectedType: DetectedType; sha256: string; byteLength: number; bytes: Buffer; scan: { scanner: string; verdict: "clean" } }
  | { state: "rejected"; code: string; detectedType: null; sha256: string; byteLength: number; scan: { scanner: string; verdict: "rejected"; code: string } };

function rejected(code: string, bytes: Buffer, scannerName: string): AttachmentReview {
  const safe = /^[A-Z0-9_]{1,40}$/.test(code) ? code : "SCAN_REJECTED";
  return {
    state: "rejected",
    code: safe,
    detectedType: null,
    sha256: sha256(bytes),
    byteLength: bytes.length,
    scan: { scanner: scannerName, verdict: "rejected", code: safe },
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let crc = n;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    table[n] = crc >>> 0;
  }
  return table;
})();

export function attachmentCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sBIT", "pHYs", "sRGB", "bKGD"]);
const PDF_ACTIVE_NAMES = new Set(["JavaScript", "JS", "Launch", "OpenAction", "AA", "RichMedia", "EmbeddedFile", "SubmitForm", "ImportData", "GoToR", "GoToE"]);
const PDF_METADATA_NAMES = new Set(["Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"]);
const PDF_MARKUP = [/<script\b/i, /<!doctype\s+html/i, /<html\b/i, /<svg\b/i, /<\?xml\b/i];
const RESERVED_SCAN_CODES = new Set(["INTEGRITY", "ACCESS_REVOKED", "SIGNATURE_MISMATCH", "EXPIRED", "OVERSIZED", "SIZE_MISMATCH", "UNSAFE_CONTENT"]);

function pdfName(latin: string, start: number): { name: string; end: number } | null {
  if (latin[start] !== "/") return null;
  let name = "";
  let index = start + 1;
  while (index < latin.length) {
    const character = latin[index];
    const code = latin.charCodeAt(index);
    if (code <= 32 || "()<>[]{}/%".includes(character)) break;
    if (character === "#") {
      const hex = latin.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) break;
      name += String.fromCharCode(Number.parseInt(hex, 16));
      index += 3;
      continue;
    }
    name += character;
    index += 1;
  }
  if (!name) return null;
  return { name, end: index };
}

function pdfHasActiveContent(latin: string): boolean {
  if (PDF_MARKUP.some((pattern) => pattern.test(latin))) return true;
  for (let index = 0; index < latin.length; index += 1) {
    if (latin[index] !== "/") continue;
    const parsed = pdfName(latin, index);
    if (!parsed) continue;
    if (PDF_ACTIVE_NAMES.has(parsed.name)) return true;
    index = parsed.end - 1;
  }
  return false;
}

function blankPdfMetadata(bytes: Buffer): Buffer {
  const output = Buffer.from(bytes);
  const latin = output.toString("latin1");
  for (let index = 0; index < latin.length; index += 1) {
    if (latin[index] !== "/") continue;
    const parsed = pdfName(latin, index);
    if (!parsed) continue;
    if (!PDF_METADATA_NAMES.has(parsed.name)) {
      index = parsed.end - 1;
      continue;
    }
    let cursor = parsed.end;
    while (cursor < latin.length && " \t\r\n\f".includes(latin[cursor])) cursor += 1;
    if (latin[cursor] === "(") {
      let end = cursor + 1;
      while (end < latin.length) {
        if (latin[end] === "\\") { end += 2; continue; }
        if (latin[end] === ")") break;
        end += 1;
      }
      for (let offset = cursor + 1; offset < end && offset < output.length; offset += 1) output[offset] = 0x20;
      index = Math.max(end, cursor);
      continue;
    }
    if (latin[cursor] === "<" && latin[cursor + 1] !== "<") {
      let end = cursor + 1;
      while (end < latin.length && latin[end] !== ">") end += 1;
      for (let offset = cursor + 1; offset < end && offset < output.length; offset += 1) output[offset] = 0x20;
      index = Math.max(end, cursor);
      continue;
    }
    index = parsed.end - 1;
  }
  return output;
}

function stripJpeg(bytes: Buffer): Buffer | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const pieces: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let index = 2;
  const marker = (): number | null => {
    if (index >= bytes.length || bytes[index] !== 0xff) return null;
    while (index < bytes.length && bytes[index] === 0xff) index += 1;
    if (index >= bytes.length) return null;
    const value = bytes[index];
    index += 1;
    return value;
  };
  while (index < bytes.length) {
    const kind = marker();
    if (kind == null) return null;
    if (kind === 0xd9) {
      pieces.push(Buffer.from([0xff, 0xd9]));
      return Buffer.concat(pieces);
    }
    if (kind === 0x00 || (kind >= 0xd0 && kind <= 0xd7)) {
      pieces.push(Buffer.from([0xff, kind]));
      continue;
    }
    if (index + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(index);
    if (length < 2 || index + length > bytes.length) return null;
    const metadata = (kind >= 0xe0 && kind <= 0xef) || kind === 0xfe;
    if (kind === 0xda) {
      let scan = index + length;
      while (scan < bytes.length) {
        if (bytes[scan] !== 0xff) { scan += 1; continue; }
        let fill = scan;
        while (fill < bytes.length && bytes[fill] === 0xff) fill += 1;
        if (fill >= bytes.length) return null;
        const next = bytes[fill];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { scan = fill + 1; continue; }
        break;
      }
      if (!metadata) pieces.push(Buffer.concat([Buffer.from([0xff, kind]), bytes.subarray(index, scan)]));
      index = scan;
      continue;
    }
    if (!metadata) pieces.push(Buffer.concat([Buffer.from([0xff, kind]), bytes.subarray(index, index + length)]));
    index += length;
  }
  return null;
}

function stripPng(bytes: Buffer): Buffer | null {
  if (bytes.length < PNG_SIG.length || !bytes.subarray(0, PNG_SIG.length).equals(PNG_SIG)) return null;
  const pieces: Buffer[] = [PNG_SIG];
  let index = PNG_SIG.length;
  let ihdr = false;
  let idat = false;
  let iend = false;
  while (index + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(index);
    if (length > bytes.length || index + 12 + length > bytes.length) return null;
    const type = bytes.subarray(index + 4, index + 8).toString("ascii");
    const checked = bytes.subarray(index + 4, index + 8 + length);
    if (attachmentCrc32(checked) !== bytes.readUInt32BE(index + 8 + length)) return null;
    const chunk = bytes.subarray(index, index + 12 + length);
    if (type === "IHDR") ihdr = true;
    if (type === "IDAT") idat = true;
    const critical = type.charCodeAt(0) >= 65 && type.charCodeAt(0) <= 90;
    index += 12 + length;
    if (type === "IEND") {
      iend = true;
      pieces.push(chunk);
      break;
    }
    if (PNG_KEEP.has(type)) pieces.push(chunk);
    else if (critical) return null;
  }
  if (!ihdr || !idat || !iend) return null;
  return Buffer.concat(pieces);
}

function skipPdfSpace(value: string, index: number): number {
  while (index < value.length && " \t\r\n\f".includes(value[index])) index += 1;
  return index;
}

function canonicalPdfFilter(name: string): "FlateDecode" | "ASCIIHexDecode" | "ASCII85Decode" | "image" | "unknown" {
  if (name === "FlateDecode" || name === "Fl") return "FlateDecode";
  if (name === "ASCIIHexDecode" || name === "AHx") return "ASCIIHexDecode";
  if (name === "ASCII85Decode" || name === "A85") return "ASCII85Decode";
  if (name === "DCTDecode" || name === "DCT" || name === "JPXDecode" || name === "JPX" || name === "CCITTFaxDecode" || name === "CCF" || name === "JBIG2Decode") return "image";
  return "unknown";
}

function dictionaryFilters(dict: string): string[] | null {
  const filters: string[] = [];
  for (let index = 0; index < dict.length; index += 1) {
    if (dict[index] !== "/") continue;
    const parsed = pdfName(dict, index);
    if (!parsed) continue;
    if (parsed.name !== "Filter") {
      index = parsed.end - 1;
      continue;
    }
    let cursor = skipPdfSpace(dict, parsed.end);
    if (dict[cursor] === "/") {
      const name = pdfName(dict, cursor);
      if (!name) return null;
      filters.push(name.name);
      index = name.end - 1;
      continue;
    }
    if (dict[cursor] !== "[") return null;
    cursor += 1;
    while (cursor < dict.length && dict[cursor] !== "]") {
      cursor = skipPdfSpace(dict, cursor);
      if (dict[cursor] === "]") break;
      if (dict[cursor] !== "/") return null;
      const name = pdfName(dict, cursor);
      if (!name) return null;
      filters.push(name.name);
      cursor = name.end;
    }
    index = cursor;
  }
  return filters;
}

function dictionaryLength(dict: string): number | "indirect" | "missing" {
  for (let index = 0; index < dict.length; index += 1) {
    if (dict[index] !== "/") continue;
    const parsed = pdfName(dict, index);
    if (!parsed) continue;
    if (parsed.name !== "Length") {
      index = parsed.end - 1;
      continue;
    }
    const cursor = skipPdfSpace(dict, parsed.end);
    const match = /^(\d+)/.exec(dict.slice(cursor));
    if (!match) return "indirect";
    if (/^\s+\d+\s+R\b/.test(dict.slice(cursor + match[1].length))) return "indirect";
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value < 0 || value > ATTACHMENT_MAX_BYTES) return "indirect";
    return value;
  }
  return "missing";
}

function dictionaryBefore(latin: string, streamAt: number): string | null {
  let end = streamAt - 1;
  while (end >= 0 && " \t\r\n\f".includes(latin[end])) end -= 1;
  if (end < 1 || latin[end] !== ">" || latin[end - 1] !== ">") return null;
  let depth = 0;
  for (let index = end; index >= 1; index -= 1) {
    if (latin[index] === ">" && latin[index - 1] === ">") {
      depth += 1;
      index -= 1;
      continue;
    }
    if (latin[index] === "<" && latin[index - 1] === "<") {
      depth -= 1;
      if (depth === 0) return latin.slice(index - 1, end + 1);
      index -= 1;
    }
  }
  return null;
}

function nextPdfStream(latin: string, from: number): number {
  let index = from;
  while (index < latin.length) {
    const at = latin.indexOf("stream", index);
    if (at < 0) return -1;
    const previous = at === 0 ? "\n" : latin[at - 1];
    const next = latin[at + 6];
    if (" \t\r\n\f>".includes(previous) && (next === "\n" || next === "\r")) return at;
    index = at + 6;
  }
  return -1;
}

function inflatePdf(data: Buffer): Buffer | null {
  if (data.length < 1 || data.length > ATTACHMENT_MAX_BYTES) return null;
  try {
    const inflated = inflateSync(data, { maxOutputLength: ATTACHMENT_MAX_BYTES });
    return inflated.length <= ATTACHMENT_MAX_BYTES ? inflated : null;
  } catch {
    return null;
  }
}

function asciiHexDecode(data: Buffer): Buffer | null {
  const out: number[] = [];
  let high: number | null = null;
  for (const byte of data) {
    if (byte === 0x3e) break;
    if (byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a || byte === 0x0c || byte === 0x00) continue;
    const hex = byte >= 48 && byte <= 57 ? byte - 48 : byte >= 65 && byte <= 70 ? byte - 55 : byte >= 97 && byte <= 102 ? byte - 87 : -1;
    if (hex < 0) return null;
    if (high == null) high = hex;
    else {
      out.push((high << 4) | hex);
      high = null;
    }
    if (out.length > ATTACHMENT_MAX_BYTES) return null;
  }
  if (high != null) out.push(high << 4);
  return Buffer.from(out);
}

function ascii85Decode(data: Buffer): Buffer | null {
  const out: number[] = [];
  let group: number[] = [];
  const flush = (count: number): boolean => {
    let value = 0;
    for (let index = 0; index < 5; index += 1) value = value * 85 + (index < group.length ? group[index] : 84);
    if (value > 0xffffffff) return false;
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
    for (let index = 0; index < count; index += 1) out.push(bytes[index]);
    group = [];
    return out.length <= ATTACHMENT_MAX_BYTES;
  };
  for (let index = 0; index < data.length; index += 1) {
    const byte = data[index];
    if (byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a || byte === 0x0c || byte === 0x00) continue;
    if (byte === 0x7e) {
      if (data[index + 1] !== 0x3e) return null;
      break;
    }
    if (byte === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0);
      if (out.length > ATTACHMENT_MAX_BYTES) return null;
      continue;
    }
    if (byte < 33 || byte > 117) return null;
    group.push(byte - 33);
    if (group.length === 5 && !flush(4)) return null;
  }
  if (group.length === 1 || (group.length > 0 && !flush(group.length - 1))) return null;
  return Buffer.from(out);
}

function decodePdfStream(filters: string[], data: Buffer): Buffer | "skip" | "active" | "malformed" {
  if (filters.length === 0 || filters.every((filter) => canonicalPdfFilter(filter) === "image")) return "skip";
  let current = data;
  let decoded = false;
  for (const filter of filters) {
    const name = canonicalPdfFilter(filter);
    if (name === "image") return decoded ? current : "skip";
    if (name === "FlateDecode") {
      const inflated = inflatePdf(current);
      if (!inflated) return "malformed";
      current = inflated;
      decoded = true;
      continue;
    }
    if (name === "ASCIIHexDecode") {
      const decodedHex = asciiHexDecode(current);
      if (!decodedHex) return "malformed";
      current = decodedHex;
      decoded = true;
      continue;
    }
    if (name === "ASCII85Decode") {
      const decoded85 = ascii85Decode(current);
      if (!decoded85) return "malformed";
      current = decoded85;
      decoded = true;
      continue;
    }
    return "active";
  }
  return current;
}

function pdfStreamBytes(bytes: Buffer, latin: string, dataStart: number, length: number | "indirect" | "missing"): Buffer | null {
  const endAt = latin.indexOf("endstream", dataStart);
  const untilEnd = (): Buffer | null => {
    if (endAt < dataStart) return null;
    let stop = endAt;
    if (stop > dataStart && bytes[stop - 1] === 0x0a) stop -= 1;
    if (stop > dataStart && bytes[stop - 1] === 0x0d) stop -= 1;
    return bytes.subarray(dataStart, stop);
  };
  if (typeof length === "number") {
    if (dataStart + length > bytes.length) return null;
    return bytes.subarray(dataStart, dataStart + length);
  }
  return untilEnd();
}

/** Reject active names in cleartext and in streams that can hide PDF objects. Image streams stay opaque. */
function inspectPdfObjects(bytes: Buffer, depth: number): "ok" | "active" | "malformed" {
  const latin = bytes.toString("latin1");
  if (pdfHasActiveContent(latin)) return "active";
  if (depth >= 4) return "active";
  let index = 0;
  let streams = 0;
  while (index < latin.length) {
    const at = nextPdfStream(latin, index);
    if (at < 0) return "ok";
    streams += 1;
    if (streams > 32) return "active";
    const dict = dictionaryBefore(latin, at);
    const dataStart = latin[at + 6] === "\r" && latin[at + 7] === "\n" ? at + 8 : at + 7;
    if (!dict || dataStart < 0) {
      index = at + 6;
      continue;
    }
    const filters = dictionaryFilters(dict);
    if (!filters) return "malformed";
    const data = pdfStreamBytes(bytes, latin, dataStart, dictionaryLength(dict));
    if (!data) return "malformed";
    const decoded = decodePdfStream(filters, data);
    if (decoded === "active" || decoded === "malformed") return decoded;
    if (decoded !== "skip") {
      const nested = inspectPdfObjects(decoded, depth + 1);
      if (nested !== "ok") return nested;
    }
    const end = latin.indexOf("endstream", dataStart);
    index = end >= dataStart ? end + "endstream".length : dataStart + data.length;
  }
  return "ok";
}

function stripPdf(bytes: Buffer): Buffer | { code: "ACTIVE_CONTENT" } | null {
  if (bytes.length < 5 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") return null;
  const inspected = inspectPdfObjects(bytes, 0);
  if (inspected === "malformed") return null;
  if (inspected === "active") return { code: "ACTIVE_CONTENT" };
  const latin = bytes.toString("latin1");
  const eof = latin.lastIndexOf("%%EOF");
  if (eof < 0) return null;
  let end = eof + 5;
  if (bytes[end] === 0x0d) end += 1;
  if (bytes[end] === 0x0a) end += 1;
  const cleaned = blankPdfMetadata(bytes.subarray(0, end));
  if (cleaned.length < 5 || cleaned.subarray(0, 5).toString("ascii") !== "%PDF-") return null;
  return cleaned;
}

/** Rewrite JPEG and PNG without metadata, and reject active PDF content. Stripping is idempotent. */
export function contentScanner(input: ScanRequest): ScanVerdict {
  if (input.detectedType === "image/jpeg") {
    const stripped = stripJpeg(input.bytes);
    return stripped ? { verdict: "clean", bytes: stripped } : { verdict: "rejected", code: "MALFORMED" };
  }
  if (input.detectedType === "image/png") {
    const stripped = stripPng(input.bytes);
    return stripped ? { verdict: "clean", bytes: stripped } : { verdict: "rejected", code: "MALFORMED" };
  }
  if (input.detectedType === "application/pdf") {
    const stripped = stripPdf(input.bytes);
    if (!stripped) return { verdict: "rejected", code: "MALFORMED" };
    if ("code" in stripped) return { verdict: "rejected", code: stripped.code };
    return { verdict: "clean", bytes: stripped };
  }
  return { verdict: "rejected", code: "MALFORMED" };
}

type ScannerFetch = (url: string, init: { method: string; redirect: "error"; signal: AbortSignal; headers: Record<string, string>; body: Uint8Array }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

async function scanWithExternal(url: string, input: ScanRequest, fetchImpl: ScannerFetch): Promise<ScanVerdict> {
  const local = contentScanner(input);
  if (local.verdict !== "clean") return local;
  const bytes = local.bytes ?? input.bytes;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: { "content-type": "application/octet-stream", "x-detected-type": input.detectedType },
      body: new Uint8Array(bytes),
    });
    if (!response.ok) throw new Error("Attachment scanner is unavailable.");
    const payload = await response.json() as { verdict?: unknown; code?: unknown };
    if (payload?.verdict === "clean") return { verdict: "clean", bytes };
    if (payload?.verdict === "rejected") {
      const code = typeof payload.code === "string" && /^[A-Z0-9_]{1,40}$/.test(payload.code) && !RESERVED_SCAN_CODES.has(payload.code) ? payload.code : "SCAN_REJECTED";
      return { verdict: "rejected", code };
    }
    throw new Error("Attachment scanner is unavailable.");
  } finally {
    clearTimeout(timer);
  }
}

/** Missing, unknown, or unreachable scanners throw. They never return clean. */
export function selectAttachmentScanner(config: { mode?: unknown; externalUrl?: unknown }, fetchImpl?: ScannerFetch): { name: "content" | "external"; scan: AttachmentScanner } {
  const mode = config.mode == null || config.mode === "" ? "content" : config.mode;
  if (mode === "content") return { name: "content", scan: contentScanner };
  const unavailable = (): { name: "content" | "external"; scan: AttachmentScanner } => ({
    name: mode === "external" ? "external" : "content",
    scan: () => { throw new Error("Attachment scanner is unavailable."); },
  });
  if (mode !== "external") return unavailable();
  const url = config.externalUrl;
  if (typeof url !== "string" || url.length > 200 || !/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/.test(url)) return unavailable();
  const fallback: ScannerFetch = (target, init) => fetch(target, init as RequestInit);
  return { name: "external", scan: (input) => scanWithExternal(url, input, fetchImpl ?? fallback) };
}

export function abandonedAttachment(input: { state: string; createdAtMs: number; nowMs: number }): boolean {
  if (input.state === "ready" || !["pending", "uploading", "quarantined", "canonicalizing", "rejected"].includes(input.state)) return false;
  return Number.isFinite(input.createdAtMs) && input.nowMs - input.createdAtMs >= ATTACHMENT_QUARANTINE_TTL_MS;
}

export function abandonedObject(input: { timeCreatedMs: number | null; nowMs: number; ready: boolean }): boolean {
  if (input.ready || input.timeCreatedMs == null || !Number.isFinite(input.timeCreatedMs)) return false;
  return input.nowMs - input.timeCreatedMs >= ATTACHMENT_QUARANTINE_TTL_MS;
}

export async function reviewAttachment(input: {
  fileName: string;
  declaredBytes: number;
  bytes: Buffer;
  expiresAtMs: number;
  nowMs: number;
  scanner: AttachmentScanner;
  scannerName?: string;
}): Promise<AttachmentReview> {
  const scannerName = input.scannerName ?? "fake";
  const named = attachmentFileName(input.fileName);
  if ("error" in named) return rejected("SIGNATURE_MISMATCH", input.bytes, "transport");
  if (input.expiresAtMs <= input.nowMs) return rejected("EXPIRED", input.bytes, "transport");
  if (input.declaredBytes > ATTACHMENT_MAX_BYTES || input.bytes.length > ATTACHMENT_MAX_BYTES) return rejected("OVERSIZED", input.bytes, "transport");
  if (!Number.isSafeInteger(input.declaredBytes) || input.declaredBytes < 1 || input.bytes.length !== input.declaredBytes) {
    return rejected("SIZE_MISMATCH", input.bytes, "transport");
  }
  const detected = detectAttachment(named.extension, input.bytes);
  if ("code" in detected) return rejected(detected.code, input.bytes, "transport");
  let verdict: ScanVerdict;
  try { verdict = await input.scanner({ bytes: input.bytes, detectedType: detected.type }); }
  catch { return rejected("SCAN_FAILED", input.bytes, scannerName); }
  if (verdict.verdict === "rejected") return rejected(verdict.code || "SCAN_REJECTED", input.bytes, scannerName);
  const produced = verdict.bytes ?? input.bytes;
  if (produced.length < 1 || produced.length > ATTACHMENT_MAX_BYTES) return rejected("SCAN_REJECTED", produced, scannerName);
  const again = detectAttachment(named.extension, produced);
  if ("code" in again) return rejected("SCAN_REJECTED", produced, scannerName);
  return {
    state: "ready",
    detectedType: again.type,
    sha256: sha256(produced),
    byteLength: produced.length,
    bytes: produced,
    scan: { scanner: scannerName, verdict: "clean" },
  };
}
