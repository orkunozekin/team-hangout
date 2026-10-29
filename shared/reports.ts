/** Wire shapes for operational report runs. Keep aligned with functions/src/reports. */
export type ReportKind = "attendance" | "facility";
export type ReportState = "queued" | "building" | "complete" | "failed";
export type Ratio = { numerator: number; denominator: number; rate: number | null };
export type AttendanceCounts = {
  events: { closed: number; cancelled: number; postponed: number; awaitingClosure: number; upcoming: number };
  eligible: number;
  present: number;
  late: number;
  absent: number;
  excused: number;
  unknown: number;
  missing: number;
  presenceRate: Ratio;
  completionCoverage: Ratio;
};
export type FacilityCounts = {
  availableMinutes: number;
  closedMinutes: number;
  unknownAvailabilityMinutes: number;
  bookedMinutes: number;
  outsideAvailabilityMinutes: number;
  unknownAvailabilityBookedMinutes: number;
  conflictMinutes: number;
  bookings: number;
  excludedBookings: number;
  closureAffectedBookings: number;
  utilization: Ratio;
};
export type ReportFilters =
  | { kind: "attendance"; programId: string; seasonId: string; teamId: string | null; fromDate: string; toDate: string }
  | { kind: "facility"; facilityId: string; fromDate: string; toDate: string };
export type ReportRun = {
  runId: string;
  kind: ReportKind;
  state: ReportState;
  filters: ReportFilters;
  interval: { startsAt: string; endsAt: string; timeZone: string; days: number; hours: number };
  reportVersion: number;
  reducerVersion: number;
  formulas: string[];
  requestedAt: string;
  completedAt: string | null;
  sourceCutoff: string | null;
  sourceDigest: string | null;
  stale: boolean;
  staleReason: string | null;
  supersedes: string | null;
  supersededBy: string | null;
  failure: { code: string; message: string } | null;
  attempts: number;
  manifest: Record<string, number> | null;
  summary: (AttendanceCounts | (FacilityCounts & { resources: number })) | null;
  rowCount: number;
};
export type ReportRow =
  | ({ kind: "team"; teamId: string; label: string } & AttendanceCounts)
  | ({ kind: "resource"; resourceId: string; label: string } & FacilityCounts);
export type ReportCommands = {
  requestReport: { input: { requestId: string; orgId: string; filters: ReportFilters }; output: { runId: string; state: ReportState } };
  rebuildReport: { input: { requestId: string; orgId: string; runId: string }; output: { runId: string; state: ReportState } };
  getReportRun: { input: { orgId: string; runId: string; cursor?: string | null }; output: { run: ReportRun; rows: ReportRow[]; nextCursor: string | null } };
  listReportRuns: {
    input: { orgId: string; programId?: string | null; teamId?: string | null; cursor?: string | null };
    output: { items: ReportRun[]; nextCursor: string | null };
  };
};

export const REPORT_FORMULAS: Record<ReportKind, string[]> = {
  attendance: [
    "Presence rate = (present + late) / (present + late + absent).",
    "Completion coverage = (present + late + absent + excused) / eligible.",
    "Eligible participants come from the frozen roster snapshot taken when each event was completed.",
    "Missing means no attendance record for the event's current schedule; unknown means a recorder chose unknown. Neither counts as absent.",
    "Cancelled and postponed events are excluded. Events that ended without being completed are listed as awaiting closure.",
    "A shared game counts once in the summary; each participant counts once per event.",
  ],
  facility: [
    "Booked utilization = booked minutes inside bookable time / bookable minutes.",
    "Bookable minutes are versioned availability windows minus applied closures, summed across resources.",
    "Booked minutes are the union of published scheduled or completed reservations, including setup and cleanup. A shared game counts once.",
    "Bookings outside availability, overlapping (conflict) minutes and time with unknown availability are shown separately.",
    "This measures reservations, not actual physical use. Attendance does not prove a field was occupied.",
  ],
};

export const REPORT_STATE_LABELS: Record<ReportState, string> = {
  queued: "Queued",
  building: "Calculating",
  complete: "Complete",
  failed: "Failed",
};

/** A zero denominator is not enough data, never 0%. */
export function formatRate(value: Ratio): string {
  if (value.rate === null) return "Not enough data";
  return `${Math.round(value.rate * 1000) / 10}%`;
}
export function formatMinutes(value: number): string {
  const total = Math.round(value);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return hours ? `${hours} h${rest ? ` ${rest} min` : ""}` : `${rest} min`;
}
export function reportStatusNote(run: Pick<ReportRun, "state" | "stale" | "staleReason" | "failure">): string | null {
  if (run.state === "failed") return run.failure?.message ?? "This report could not be calculated.";
  if (run.state !== "complete") return "This report is still calculating. Rows appear only when every source has been read.";
  if (run.stale) return "Source records changed after this report was calculated. Rebuild it to see current figures; this snapshot stays as recorded.";
  return null;
}
