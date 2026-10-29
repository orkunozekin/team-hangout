/**
 * Pure operational report reducers. No Firebase imports, so native tests can run the hand-calculated corpus.
 * Keep wire shapes aligned with shared/reports.ts.
 */
export const REPORT_REDUCER_VERSION = 1;
export const MAX_REPORT_DAYS = 366;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

export type Interval = { startsAt: string; endsAt: string };
type Span = [number, number];

export class ReportInputError extends Error {}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let result = formatters.get(timeZone);
  if (!result) {
    result = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    formatters.set(timeZone, result);
  }
  return result;
}
/** The local wall clock at an instant, expressed as if it were UTC milliseconds. */
function wall(instant: number, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find(part => part.type === type)!.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
}
function dateMs(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ReportInputError('Use YYYY-MM-DD dates.');
  const value = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== date) throw new ReportInputError('Use real calendar dates.');
  return value;
}

/**
 * First instant of a local calendar day. When midnight falls in a daylight-saving gap the day starts at the
 * transition, so consecutive local days always partition time without gaps or overlap.
 */
export function localDayStart(date: string, timeZone: string): number {
  const target = dateMs(date);
  const candidates = [-14, 0, 14].map(hours => target - (wall(target + hours * 3_600_000, timeZone) - (target + hours * 3_600_000)));
  const valid = candidates.filter(candidate => wall(candidate, timeZone) >= target).sort((a, b) => a - b);
  // A midnight gap: the first valid candidate is the transition itself, where the local clock already reads after midnight.
  return valid[0];
}

/** Inclusive local dates resolved to one UTC half-open interval. */
export function reportInterval(fromDate: string, toDate: string, timeZone: string) {
  const from = dateMs(fromDate), to = dateMs(toDate);
  if (to < from) throw new ReportInputError('The end date must not precede the start date.');
  const days = (to - from) / DAY_MS + 1;
  if (days > MAX_REPORT_DAYS) throw new ReportInputError(`Reports cover at most ${MAX_REPORT_DAYS} days. Split the range into shorter runs.`);
  const next = new Date(to + DAY_MS).toISOString().slice(0, 10);
  const startsAt = localDayStart(fromDate, timeZone), endsAt = localDayStart(next, timeZone);
  return { fromDate, toDate, timeZone, days, startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString(), hours: (endsAt - startsAt) / 3_600_000 };
}

const ms = (value: string) => Date.parse(value);
const span = (interval: Interval): Span => [ms(interval.startsAt), ms(interval.endsAt)];

/** Sorted union of half-open spans. Adjacent spans merge. */
export function union(spans: Span[]): Span[] {
  const sorted = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const result: Span[] = [];
  for (const [a, b] of sorted) {
    const last = result[result.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else result.push([a, b]);
  }
  return result;
}
export function intersect(a: Span[], b: Span[]): Span[] {
  const x = union(a), y = union(b), result: Span[] = [];
  for (let i = 0, j = 0; i < x.length && j < y.length;) {
    const start = Math.max(x[i][0], y[j][0]), end = Math.min(x[i][1], y[j][1]);
    if (end > start) result.push([start, end]);
    if (x[i][1] < y[j][1]) i += 1; else j += 1;
  }
  return result;
}
export function subtract(a: Span[], b: Span[]): Span[] {
  const cut = union(b), result: Span[] = [];
  for (const [start, end] of union(a)) {
    let cursor = start;
    for (const [c, d] of cut) {
      if (d <= cursor || c >= end) continue;
      if (c > cursor) result.push([cursor, c]);
      cursor = Math.max(cursor, d);
      if (cursor >= end) break;
    }
    if (cursor < end) result.push([cursor, end]);
  }
  return result;
}
/** Time covered by two or more spans at once. */
export function overlapping(spans: Span[]): Span[] {
  const edges = spans.filter(([a, b]) => b > a).flatMap(([a, b]) => [[a, 1], [b, -1]] as [number, number][])
    .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const result: Span[] = [];
  let depth = 0, since = 0;
  for (const [at, delta] of edges) {
    if (depth >= 2 && depth + delta < 2 && at > since) result.push([since, at]);
    if (depth < 2 && depth + delta >= 2) since = at;
    depth += delta;
  }
  return union(result);
}
const minutes = (spans: Span[]) => spans.reduce((sum, [a, b]) => sum + (b - a), 0) / MINUTE_MS;

export type Ratio = { numerator: number; denominator: number; rate: number | null };
/** A zero denominator is "not enough data", never 0%. */
export function ratio(numerator: number, denominator: number): Ratio {
  return { numerator, denominator, rate: denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : null };
}

export type RecordedAttendance = 'present' | 'late' | 'absent' | 'excused' | 'unknown';
export type AttendanceEventInput = {
  eventId: string;
  /** Lifecycle status after closure effects. */
  status: 'scheduled' | 'postponed' | 'cancelled' | 'completed';
  ended: boolean;
  /** Completed with a frozen roster snapshot. */
  closed: boolean;
  teamIds: string[];
  /** Frozen snapshot rows. `attendance` is null when no record exists for the current schedule version. */
  participants: { participantId: string; eligibleTeamIds: string[]; attendance: RecordedAttendance | null }[];
};
export type AttendanceCounts = {
  events: { closed: number; cancelled: number; postponed: number; awaitingClosure: number; upcoming: number };
  eligible: number; present: number; late: number; absent: number; excused: number; unknown: number; missing: number;
  presenceRate: Ratio; completionCoverage: Ratio;
};
function emptyAttendance(): AttendanceCounts {
  return { events: { closed: 0, cancelled: 0, postponed: 0, awaitingClosure: 0, upcoming: 0 },
    eligible: 0, present: 0, late: 0, absent: 0, excused: 0, unknown: 0, missing: 0, presenceRate: ratio(0, 0), completionCoverage: ratio(0, 0) };
}
function finishAttendance(row: AttendanceCounts): AttendanceCounts {
  const attended = row.present + row.late;
  return { ...row, presenceRate: ratio(attended, attended + row.absent), completionCoverage: ratio(attended + row.absent + row.excused, row.eligible) };
}
function lifecycle(row: AttendanceCounts, event: AttendanceEventInput): boolean {
  if (event.status === 'cancelled') row.events.cancelled += 1;
  else if (event.status === 'postponed') row.events.postponed += 1;
  else if (event.closed) { row.events.closed += 1; return true; }
  else if (event.ended) row.events.awaitingClosure += 1;
  else row.events.upcoming += 1;
  return false;
}
function tally(row: AttendanceCounts, attendance: RecordedAttendance | null) {
  row.eligible += 1;
  if (attendance === null) row.missing += 1; else row[attendance] += 1;
}

/**
 * Presence = (present + late) / (present + late + absent). Coverage = (present + late + absent + excused) / eligible.
 * The summary counts each participant once per event even when they are eligible on both sides of a shared game, and
 * counts the canonical event once; per-team rows count the participant for each team they were eligible for.
 */
export function reduceAttendance(events: AttendanceEventInput[], scopeTeamIds: string[] | null) {
  const inScope = (teamId: string) => scopeTeamIds === null || scopeTeamIds.includes(teamId);
  const summary = emptyAttendance();
  const teams = new Map<string, AttendanceCounts>();
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    const eventTeams = [...new Set(event.teamIds)].filter(inScope);
    if (!eventTeams.length) continue;
    const counted = lifecycle(summary, event);
    for (const teamId of eventTeams) {
      if (!teams.has(teamId)) teams.set(teamId, emptyAttendance());
      lifecycle(teams.get(teamId)!, event);
    }
    if (!counted) continue;
    const people = new Set<string>();
    for (const participant of event.participants) {
      const eligible = participant.eligibleTeamIds.filter(teamId => eventTeams.includes(teamId));
      if (!eligible.length || people.has(participant.participantId)) continue;
      people.add(participant.participantId);
      tally(summary, participant.attendance);
      for (const teamId of eligible) tally(teams.get(teamId)!, participant.attendance);
    }
  }
  return {
    summary: finishAttendance(summary),
    teams: [...teams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([teamId, row]) => ({ teamId, ...finishAttendance(row) })),
  };
}

export type AvailabilityVersion = { revision: number; effectiveFrom: string; windows: Interval[] };
export type BookingInput = { eventId: string; status: string; occupancy: Interval };
export type ResourceInput = {
  resourceId: string;
  /** Every version effective during the interval, plus the one in force at its start. */
  availability: AvailabilityVersion[];
  closures: Interval[];
  bookings: BookingInput[];
};
export type ResourceUsage = {
  resourceId: string;
  availableMinutes: number; closedMinutes: number; unknownAvailabilityMinutes: number;
  bookedMinutes: number; outsideAvailabilityMinutes: number; unknownAvailabilityBookedMinutes: number; conflictMinutes: number;
  bookings: number; excludedBookings: number; closureAffectedBookings: number;
  utilization: Ratio;
};

/** Availability in force from each version's effectiveFrom until the next version takes over. */
function effectiveWindows(versions: AvailabilityVersion[]): { known: Span[]; windows: Span[] } {
  const sorted = [...versions].sort((a, b) => ms(a.effectiveFrom) - ms(b.effectiveFrom));
  const windows: Span[] = [];
  sorted.forEach((version, index) => {
    const period: Span = [ms(version.effectiveFrom), index + 1 < sorted.length ? ms(sorted[index + 1].effectiveFrom) : Infinity];
    windows.push(...intersect(version.windows.map(span), [period]));
  });
  return { known: sorted.length ? [[ms(sorted[0].effectiveFrom), Infinity]] : [], windows: union(windows) };
}

/**
 * Booked utilization = union of scheduled/completed published occupancy within bookable minutes / bookable minutes.
 * Bookable minutes are versioned availability windows minus applied closures. This measures reservations, not
 * physical use. Time before the first availability version is unknown and stays out of both sides of the ratio.
 */
export function reduceResource(input: ResourceInput, interval: Interval): ResourceUsage {
  const report: Span[] = [span(interval)];
  const { known, windows } = effectiveWindows(input.availability);
  const knownPeriod = intersect(report, known);
  const unknownPeriod = subtract(report, known);
  const closures = union(input.closures.map(span));
  const scheduled = intersect(windows, report);
  const available = subtract(scheduled, closures);
  const counted: Span[] = [];
  let bookings = 0, excludedBookings = 0, closureAffectedBookings = 0;
  const seen = new Set<string>();
  for (const booking of input.bookings) {
    // A shared canonical game is one booking, never one per team.
    if (seen.has(booking.eventId)) continue;
    seen.add(booking.eventId);
    const occupied = span(booking.occupancy);
    if (!intersect([occupied], report).length) continue;
    if (booking.status !== 'scheduled' && booking.status !== 'completed') { excludedBookings += 1; continue; }
    // An applied closure postpones a scheduled booking even before the closure job rewrites the event.
    if (booking.status === 'scheduled' && intersect([occupied], closures).length) { closureAffectedBookings += 1; continue; }
    bookings += 1;
    counted.push(occupied);
  }
  const occupied = intersect(union(counted), report);
  const booked = intersect(occupied, available);
  return {
    resourceId: input.resourceId,
    availableMinutes: minutes(available),
    closedMinutes: minutes(intersect(scheduled, closures)),
    unknownAvailabilityMinutes: minutes(unknownPeriod),
    bookedMinutes: minutes(booked),
    outsideAvailabilityMinutes: minutes(subtract(intersect(occupied, knownPeriod), available)),
    unknownAvailabilityBookedMinutes: minutes(intersect(occupied, unknownPeriod)),
    conflictMinutes: minutes(intersect(overlapping(counted), report)),
    bookings, excludedBookings, closureAffectedBookings,
    utilization: ratio(minutes(booked), minutes(available)),
  };
}

/** Totals sum resource-minutes across resources; they are never an average of percentages. */
export function reduceFacility(resources: ResourceInput[], interval: Interval) {
  const rows = [...resources].sort((a, b) => (a.resourceId < b.resourceId ? -1 : 1)).map(resource => reduceResource(resource, interval));
  const sum = (field: keyof ResourceUsage) => rows.reduce((total, row) => total + (row[field] as number), 0);
  const fields = ['availableMinutes', 'closedMinutes', 'unknownAvailabilityMinutes', 'bookedMinutes', 'outsideAvailabilityMinutes',
    'unknownAvailabilityBookedMinutes', 'conflictMinutes', 'bookings', 'excludedBookings', 'closureAffectedBookings'] as const;
  const totals = Object.fromEntries(fields.map(field => [field, sum(field)])) as Record<(typeof fields)[number], number>;
  return { summary: { resources: rows.length, ...totals, utilization: ratio(totals.bookedMinutes, totals.availableMinutes) }, resources: rows };
}
