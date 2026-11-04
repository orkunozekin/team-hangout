/** Wire contracts for Phase 3 practice resources and event plans. Keep aligned with functions/src/resources/practice.ts. */
export const PRACTICE_AGE_MIN = 4;
export const PRACTICE_AGE_MAX = 19;
export const PRACTICE_PLAN_ITEMS = 20;
export const PRACTICE_PLANNED_MAX = 180;
export const PRACTICE_PLAN_TOTAL = 600;
export const PRACTICE_NOTE_MAX = 2000;
export const PRACTICE_HOUSEHOLD_NOTE_MAX = 1000;

export const RIGHTS_ORIGINS = ["original", "commissioned", "licensed"] as const;
export type RightsOrigin = (typeof RIGHTS_ORIGINS)[number];
export type ResourceStatus = "draft" | "published" | "withdrawn";
export type ResourceAvailability = "available" | "withdrawn" | "expired" | "unpublished";
/** Why a plan activity needs attention. Superseded keeps working; withdrawn and expired block saving and publishing. */
export type PlanNotice = "superseded" | "withdrawn" | "expired" | null;

export type ResourceContent = {
  title: string;
  objectives: string[];
  ageMin: number;
  ageMax: number;
  durationMinutes: number;
  equipment: string[];
  instructions: string;
  safetyNotes: string;
};

export type ResourceRights = {
  origin: RightsOrigin;
  owner: string;
  allowedUses: string;
  attribution: string | null;
  evidence: string;
  licenseUrl: string | null;
  expiresAt: string | null;
  derivativesAllowed: boolean;
};

/** A published resource as a coach sees it: no rights evidence or reviewer identity. */
export type CoachResource = ResourceContent & {
  resourceId: string;
  version: number;
  sportCode: string | null;
  attribution: string | null;
};

export type PlanItem = ResourceContent & {
  resourceId: string;
  version: number;
  attribution: string | null;
  plannedMinutes: number;
  notice?: PlanNotice;
};

export type CoachPracticePlan = {
  enabled: true;
  canManage: true;
  orgId: string;
  programId: string;
  eventId: string;
  teamId: string;
  eventType: string;
  revision: number;
  items: PlanItem[];
  householdNote: string;
  privateNote: string;
  publication: { state: "private" | "published"; sourceRevision: number | null; publishedAt: string | null };
};

export type HouseholdPlanItem = {
  title: string;
  plannedMinutes: number;
  notice: PlanNotice;
  objectives?: string[];
  equipment?: string[];
  instructions?: string;
  safetyNotes?: string;
  attribution?: string | null;
};

export type HouseholdPracticePlan = {
  enabled: true;
  canManage: false;
  eventId: string;
  teamId: string;
  eventType: string;
  state: "published" | "unpublished";
  householdNote?: string;
  publishedAt?: string;
  items?: HouseholdPlanItem[];
};

export type EventPracticePlan = CoachPracticePlan | HouseholdPracticePlan | { enabled: false; canManage: false; eventId: string; teamId: string };

export type PlanItemInput = { resourceId: string; version: number; plannedMinutes: number };

export const NOTICE_LABELS: Record<Exclude<PlanNotice, null>, string> = {
  superseded: "A newer reviewed version exists. This plan keeps the version it was built with.",
  withdrawn: "This resource was withdrawn. Remove it before saving or publishing.",
  expired: "The permission for this resource expired. Remove it before saving or publishing.",
};

/** Returns a problem for the planned minutes, mirroring the backend limits. */
export function plannedProblem(items: { plannedMinutes: number }[]): string | null {
  if (items.length > PRACTICE_PLAN_ITEMS) return `A plan holds at most ${PRACTICE_PLAN_ITEMS} activities.`;
  if (items.some((item) => !Number.isInteger(item.plannedMinutes) || item.plannedMinutes < 1 || item.plannedMinutes > PRACTICE_PLANNED_MAX)) {
    return `Each activity needs 1 to ${PRACTICE_PLANNED_MAX} minutes.`;
  }
  const total = items.reduce((sum, item) => sum + item.plannedMinutes, 0);
  return total > PRACTICE_PLAN_TOTAL ? `Plans are limited to ${PRACTICE_PLAN_TOTAL} minutes.` : null;
}

/** Reads a typed age; blank clears the filter. Returns undefined for out-of-range text. */
export function parseAge(value: string): number | null | undefined {
  const text = value.trim();
  if (!text) return null;
  if (!/^\d{1,2}$/.test(text)) return undefined;
  const age = Number(text);
  return age >= PRACTICE_AGE_MIN && age <= PRACTICE_AGE_MAX ? age : undefined;
}

export const ageLabel = (row: { ageMin: number; ageMax: number }) =>
  row.ageMin === row.ageMax ? `Age ${row.ageMin}` : `Ages ${row.ageMin}-${row.ageMax}`;

/** Editor list row. Availability folds in rights expiry; withdrawn is terminal. */
export type EditorResourceRow = {
  resourceId: string;
  programId: string;
  sportCode: string | null;
  title: string;
  status: ResourceStatus;
  availability: ResourceAvailability;
  revision: number;
  publishedVersion: number | null;
  draftVersion: number | null;
  ageMin: number | null;
  ageMax: number | null;
  rightsExpiresAt: string | null;
  reviewedAt: string | null;
};

export type ResourceVersion = { version: number; content: ResourceContent; rights: ResourceRights; editedBy: string; editedAt?: string };
export type ResourceReview = { reviewerUid: string; qualification: string; rightsVerified: true; ageSafetyReviewed: true; note: string | null; reviewedAt: string };

export type ResourceDetail = {
  resourceId: string;
  programId: string;
  sportCode: string | null;
  status: ResourceStatus;
  availability: ResourceAvailability;
  revision: number;
  draft: ResourceVersion | null;
  published: (ResourceVersion & { review: ResourceReview; publishedAt: string }) | null;
  withdrawal: { reason: string; by: string; at: string } | null;
  canReview: boolean;
};

type ResourceResult = { requestId: string; revision: number; state: ResourceStatus; resourceId: string; version: number | null };

export type PracticeCommands = {
  listPracticeResources: {
    input: { orgId: string; programId: string; status?: ResourceStatus; age?: number; pageSize?: number; cursor?: string };
    output: { programId: string; items: EditorResourceRow[]; nextCursor: string | null };
  };
  getPracticeResource: { input: { orgId: string; resourceId: string }; output: ResourceDetail };
  savePracticeResource: {
    input: { requestId: string; orgId: string; resourceId: string | null; expectedRevision: number; payload: { programId: string; content: ResourceContent; rights: ResourceRights } };
    output: ResourceResult;
  };
  publishPracticeResource: {
    input: {
      requestId: string; orgId: string; resourceId: string; expectedRevision: number;
      payload: { action: "approve"; rightsVerified: boolean; ageSafetyReviewed: boolean; reviewNote: string | null } | { action: "withdraw"; reason: string };
    };
    output: ResourceResult;
  };
};

export const AVAILABILITY_LABELS: Record<ResourceAvailability, string> = {
  available: "Published",
  unpublished: "Draft, awaiting review",
  withdrawn: "Withdrawn",
  expired: "Permission expired",
};

export const ORIGIN_LABELS: Record<RightsOrigin, string> = {
  original: "Original, written by the organization",
  commissioned: "Commissioned by the organization",
  licensed: "Licensed from a third party",
};

/** Splits one item per line, dropping blanks. */
export const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);
