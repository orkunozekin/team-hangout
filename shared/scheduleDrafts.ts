import type {
  Assignment,
  Fixture,
  ScheduleResult,
  Validation,
} from "../functions/src/scheduling/model";
import type { DraftFields } from "../functions/src/scheduling/model";
export type { DraftFields } from "../functions/src/scheduling/model";
export type ScheduleDraft = {
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
  publishScheduleDraft: { input: Edit; output: never };
};
