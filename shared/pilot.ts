/** Callable JSON only. Counts and flags, never names, tokens, or file bytes. */
export const PILOT_ROLLBACK_CONFIRM = "DISABLE_PHASE2_WRITERS";

export type PilotFlag = { name: string; enabled: boolean };
export type PilotStuckOperation = { id: string; state: string; ageMinutes: number };
export type PilotAttachmentCounts = {
  pending: number;
  uploading: number;
  quarantined: number;
  canonicalizing: number;
  rejected: number;
  ready: number;
  truncated: boolean;
};
export type PilotRejection = { code: string; count: number };
export type PilotOperations = {
  flags: PilotFlag[];
  youthChannels: "approved" | "closed";
  stuckOperations: PilotStuckOperation[];
  attachments: PilotAttachmentCounts;
  rejections: PilotRejection[];
  rejectionsTruncated: boolean;
  scanner: { mode: string; externalConfigured: boolean };
  budgets: { attachmentMaxBytes: number; functionMemory: string; stuckAfterMinutes: number };
};
export type PilotRollback = {
  flagsDisabled: string[];
  quarantinedOperationIds: string[];
  truncated: boolean;
};
export type PilotCommands = {
  listPilotOperations: { input: { orgId: string }; output: PilotOperations };
  applyPilotRollback: {
    input: { orgId: string; requestId: string; confirm: typeof PILOT_ROLLBACK_CONFIRM };
    output: PilotRollback;
  };
};
