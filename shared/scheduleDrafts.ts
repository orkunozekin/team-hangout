import type {
  Assignment,
  Fixture,
  ScheduleResult,
  Validation,
} from "../functions/src/scheduling/model";
import type { DraftFields } from "../functions/src/scheduling/model";
export type { DraftFields } from "../functions/src/scheduling/model";
export type ScheduleDraft = {
  publicationOperationId: string | null;
  timeZone: string;
  draftId: string;
  divisionId: string;
  revision: number;
  state: "privateDraft";
  fields: DraftFields;
  assignments: Assignment[];
  fixtures: Fixture[];
  teams: { id: string; name: string }[];
  validation: Validation | null;
  validationRevision: number | null;
  inputHash: string | null;
  search: Omit<ScheduleResult, "assignments" | "validation"> | null;
};
type Identity = { orgId: string; draftId: string };
type Edit = Identity & { expectedRevision: number; requestId: string };
export type DraftCommands = {
  generateScheduleDraft: {
    input: Edit & { divisionId: string; fields: DraftFields };
    output: ScheduleDraft;
  };
  saveScheduleDraft: {
    input: Edit & { fields: DraftFields; assignments: Assignment[] };
    output: ScheduleDraft;
  };
  validateScheduleDraft: { input: Edit; output: ScheduleDraft };
  getScheduleDraft: { input: Identity; output: ScheduleDraft };
  publishScheduleDraft: {
    input: Edit & { confirmed: true };
    output: SchedulePublication;
  };
  getSchedulePublication: {
    input: Identity;
    output: { operation: SchedulePublication | null };
  };
  advanceSchedulePublication: {
    input: Identity & {
      requestId: string;
      operationId: string;
      expectedRevision: number;
      fencingToken: number;
      action: "advance" | "resume" | "abort";
    };
    output: SchedulePublication;
  };
};

export type SchedulePublication = {
  operationId: string;
  draftId: string;
  revision: number;
  state: "staging" | "promoting" | "verifying" | "committed" | "aborted";
  stagingCursor: number;
  promotionCursor: number;
  total: number;
  fencingToken: number;
  expiresAt: string;
  committedAt: string | null;
};
