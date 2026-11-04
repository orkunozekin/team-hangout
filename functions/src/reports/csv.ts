/**
 * Pure CSV serializer for complete report snapshots. No Firebase imports.
 * Columns are an explicit allowlist, so stored fields outside it never reach a file.
 * Keep wire shapes aligned with shared/reports.ts.
 */
export const REPORT_EXPORT_VERSION = 1;

type Data = Record<string, any>;
type Column = [header: string, value: (row: Data) => unknown];

const ratio = (key: string, label: string): Column[] => [
  [`${label}Numerator`, row => row[key]?.numerator],
  [`${label}Denominator`, row => row[key]?.denominator],
  // A zero denominator is not enough data, never 0%.
  [label, row => (row[key]?.rate == null ? 'not enough data' : row[key].rate)],
];
const counts = (keys: string[]): Column[] => keys.map(key => [key, row => row[key]]);

export const REPORT_EXPORT_COLUMNS: Record<'attendance' | 'facility', Column[]> = {
  attendance: [
    ['rowKind', row => row.kind], ['teamId', row => row.teamId], ['team', row => row.label],
    ...counts(['eligible', 'present', 'late', 'absent', 'excused', 'unknown', 'missing']),
    ...ratio('presenceRate', 'presenceRate'), ...ratio('completionCoverage', 'completionCoverage'),
    ['eventsClosed', row => row.events?.closed], ['eventsCancelled', row => row.events?.cancelled], ['eventsPostponed', row => row.events?.postponed],
    ['eventsAwaitingClosure', row => row.events?.awaitingClosure], ['eventsUpcoming', row => row.events?.upcoming],
  ],
  facility: [
    ['rowKind', row => row.kind], ['resourceId', row => row.resourceId], ['resource', row => row.label],
    ...counts(['availableMinutes', 'closedMinutes', 'unknownAvailabilityMinutes', 'bookedMinutes', 'outsideAvailabilityMinutes',
      'unknownAvailabilityBookedMinutes', 'conflictMinutes', 'bookings', 'excludedBookings', 'closureAffectedBookings']),
    ...ratio('utilization', 'utilization'),
  ],
};

/** Leading characters a spreadsheet may evaluate, including full-width forms. */
const FORMULA_LEAD = /^[\s 　]*[=+\-@＝＋－＠]/;

/**
 * Text that a spreadsheet could read as a formula is prefixed with an apostrophe, including after leading
 * whitespace and when it starts with a tab or carriage return. Every cell is quoted and inner quotes doubled.
 */
export function csvCell(value: unknown): string {
  if (value == null) return '""';
  if (typeof value === 'number') return Number.isFinite(value) ? `"${value}"` : '""';
  let text = String(value);
  if (FORMULA_LEAD.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export const csvLine = (cells: unknown[]) => cells.map(csvCell).join(',');

function safeName(value: unknown) {
  return String(value ?? '').replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 80);
}

/**
 * One file per complete run: a metadata block (run ID, versions, filters, interval, stale flag, formulas),
 * a blank line, then the versioned header, the summary row and the snapshot rows in stored order.
 * Figures are copied from the snapshot, never recomputed.
 */
export function reportCsv(run: Data, rows: Data[]): { fileName: string; csv: string; rowCount: number } {
  const kind = run.kind as 'attendance' | 'facility';
  const columns = REPORT_EXPORT_COLUMNS[kind];
  if (!columns) throw new Error('Unsupported report kind.');
  const filters = run.filters ?? {};
  const filterKeys = kind === 'attendance' ? ['programId', 'seasonId', 'teamId', 'fromDate', 'toDate'] : ['facilityId', 'fromDate', 'toDate'];
  const meta: unknown[][] = [
    ['exportFormat', 'team-hangout-report-csv'], ['exportVersion', REPORT_EXPORT_VERSION],
    ['runId', run.runId], ['reportKind', kind], ['reportVersion', run.reportVersion], ['formulaVersion', run.reducerVersion],
    ...filterKeys.map(key => [`filter.${key}`, filters[key] ?? '']),
    ['intervalStartsAt', run.interval?.startsAt], ['intervalEndsAt', run.interval?.endsAt], ['timeZone', run.interval?.timeZone],
    ['sourceCutoff', run.sourceCutoff], ['completedAt', run.completedAt], ['sourceDigest', run.sourceDigest],
    ['stale', run.stale === true], ['staleReason', run.staleReason ?? ''], ['supersededBy', run.supersededBy ?? ''],
    ['rowCount', rows.length],
    ...((run.formulas ?? []) as string[]).map(line => ['formula', line]),
    ['note', 'Aggregate counts only. Participant names, contacts and coaching notes are never exported.'],
  ];
  const summary = { ...(run.summary ?? {}), kind: 'summary', label: kind === 'attendance' ? 'All teams' : 'All resources' };
  const lines = [
    ...meta.map(csvLine), '',
    csvLine(columns.map(([header]) => header)),
    ...[summary, ...rows].map(row => csvLine(columns.map(([, value]) => value(row)))),
  ];
  const fileName = `team-hangout-${kind}-${safeName(filters.fromDate)}-to-${safeName(filters.toDate)}-${safeName(run.runId)}.csv`;
  // The byte order mark lets spreadsheet apps read UTF-8 labels correctly.
  return { fileName, csv: `﻿${lines.join('\r\n')}\r\n`, rowCount: rows.length };
}
