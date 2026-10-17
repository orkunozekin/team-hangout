import type { AttendanceStatus } from "./operations";
export type AttendanceRow = {
  participantId: string;
  displayName: string;
  eligible: boolean;
  rosterStatus: string;
  canRecord: boolean;
  intended: "yes" | "no" | "maybe" | "unanswered" | "needsReconfirmation";
  status: AttendanceStatus;
  revision: number;
  previousStatus: AttendanceStatus | null;
  recordedBy: string | null;
  recordedAt: string | null;
  source: "coach" | "guardian" | "self" | null;
  method?: "simple" | "location" | null;
  correctionReason: string | null;
};
/** Phase 3 uses frozen eligibility at capturedRevision; missing/current-version attendance is unknown, never absent. */
export type EventAttendance = {
  eventId: string;
  teamId: string;
  eventRevision: number;
  scheduleVersion: number;
  status: string;
  timeZone: string;
  snapshot: {
    schemaVersion: 2;
    capturedRevision: number;
    scheduleVersion: number;
    capturedAt: string;
  } | null;
  items: AttendanceRow[];
  nextCursor: string | null;
};
export type AttendanceHistory = {
  items: {
    revision: number;
    status: AttendanceStatus;
    previousStatus: AttendanceStatus;
    recordedBy: string;
    recordedAt: string;
    source: "coach" | "guardian" | "self";
    method?: "simple" | "location" | null;
    reason: string | null;
    scheduleVersion: number;
  }[];
  nextCursor: string | null;
};
