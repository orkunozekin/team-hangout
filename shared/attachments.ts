import type { ConversationScopeType } from "./conversations";

/** Keep aligned with functions/src/communications/attachmentScan.ts. */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_LIMIT = 3;

export type AttachmentState = "pending" | "ready" | "rejected";

export type AttachmentUpload = {
  id: string;
  uploadUrl: string;
  token: string;
  expiresAt: string;
  maxBytes: number;
  state: "pending";
};

export type AttachmentFinalize = {
  id: string;
  state: "ready" | "rejected";
  detectedType: "image/jpeg" | "image/png" | "application/pdf" | null;
  byteLength: number;
  sha256: string | null;
  fileName: string | null;
  scan: { scanner: "fake"; verdict: "clean" | "rejected"; code?: string } | null;
  rejectionCode: string | null;
};

type Scope = { orgId: string; scopeType: ConversationScopeType; scopeId: string };

export type AttachmentCommands = {
  createAttachmentUpload: {
    input: Scope & { requestId: string; fileName: string; declaredBytes: number };
    output: AttachmentUpload;
  };
  finalizeAttachment: {
    input: Scope & { requestId: string; attachmentId: string };
    output: AttachmentFinalize;
  };
};
