import {
  localDayStart, MAX_REPORT_DAYS, ratio, reduceAttendance, reduceFacility, reduceResource, reportInterval,
  type AttendanceEventInput, type BookingInput,
} from '../../../functions/src/reports/reducers';
import { formatMinutes, formatRate, reportStatusNote } from '../../../shared/reports';

const person = (participantId: string, eligibleTeamIds: string[], attendance: AttendanceEventInput['participants'][number]['attendance']) =>
  ({ participantId, eligibleTeamIds, attendance });
const event = (eventId: string, teamIds: string[], status: AttendanceEventInput['status'], extra: Partial<AttendanceEventInput> = {}): AttendanceEventInput =>
  ({ eventId, teamIds, status, ended: true, closed: status === 'completed', participants: [], ...extra });

// Hand-calculated attendance corpus. E1 is one canonical game shared by teams A and B.
const shared = event('e1', ['A', 'B'], 'completed', { participants: [
  person('p1', ['A'], 'present'), person('p2', ['A'], 'late'), person('p3', ['A'], 'absent'), person('p4', ['A'], 'excused'),
  person('p5', ['A'], 'unknown'), person('p6', ['A'], null),
  // Not eligible in the frozen snapshot (removed before completion), so outside every denominator.
  person('p7', [], 'present'),
  // Rostered on both sides of the shared game.
  person('p8', ['A', 'B'], 'present'),
  person('q1', ['B'], 'absent'),
] });
const corpus: AttendanceEventInput[] = [
  shared,
  event('e2', ['A'], 'cancelled', { participants: [person('p1', ['A'], 'present')] }),
  event('e3', ['A'], 'postponed'),
  event('e4', ['A'], 'scheduled'),
  event('e5', ['B'], 'scheduled', { ended: false }),
  // The same canonical game seen from the second team's calendar is not counted twice.
  shared,
];

describe('attendance reducer', () => {
  test('separates missing, unknown and excused from absent and counts a shared game once', () => {
    const { summary, teams } = reduceAttendance(corpus, null);
    expect(summary.events).toEqual({ closed: 1, cancelled: 1, postponed: 1, awaitingClosure: 1, upcoming: 1 });
    // eligible p1-p6, p8, q1 = 8; present p1 p8; absent p3 q1.
    expect([summary.eligible, summary.present, summary.late, summary.absent, summary.excused, summary.unknown, summary.missing]).toEqual([8, 2, 1, 2, 1, 1, 1]);
    // (2 + 1) / (2 + 1 + 2) and (2 + 1 + 2 + 1) / 8.
    expect(summary.presenceRate).toEqual({ numerator: 3, denominator: 5, rate: 0.6 });
    expect(summary.completionCoverage).toEqual({ numerator: 6, denominator: 8, rate: 0.75 });
    const [a, b] = teams;
    expect(a.teamId).toBe('A');
    expect(a.events).toEqual({ closed: 1, cancelled: 1, postponed: 1, awaitingClosure: 1, upcoming: 0 });
    expect([a.eligible, a.present, a.absent, a.missing]).toEqual([7, 2, 1, 1]);
    expect(a.presenceRate.rate).toBe(0.75);
    expect(a.completionCoverage).toEqual({ numerator: 5, denominator: 7, rate: 0.7143 });
    expect(b.events).toEqual({ closed: 1, cancelled: 0, postponed: 0, awaitingClosure: 0, upcoming: 1 });
    expect([b.eligible, b.present, b.absent, b.presenceRate.rate, b.completionCoverage.rate]).toEqual([2, 1, 1, 0.5, 1]);
  });

  test('a team scope keeps only that team and still counts a dual-rostered participant once', () => {
    const { summary, teams } = reduceAttendance(corpus, ['B']);
    expect(teams.map(row => row.teamId)).toEqual(['B']);
    expect([summary.eligible, summary.present, summary.absent]).toEqual([2, 1, 1]);
    expect(summary.events.closed).toBe(1);
  });

  test('zero denominators are not enough data instead of 0%', () => {
    const { summary } = reduceAttendance([event('z', ['A'], 'completed', { participants: [person('p1', ['A'], 'excused'), person('p2', ['A'], null)] })], null);
    expect(summary.presenceRate).toEqual({ numerator: 0, denominator: 0, rate: null });
    expect(formatRate(summary.presenceRate)).toBe('Not enough data');
    expect(formatRate(summary.completionCoverage)).toBe('50%');
    expect(reduceAttendance([], null).summary.completionCoverage.rate).toBeNull();
  });
});

describe('local report intervals', () => {
  test('spring-forward, fall-back and midnight-gap days resolve to their real UTC length', () => {
    expect(reportInterval('2026-03-08', '2026-03-08', 'America/New_York')).toMatchObject({ startsAt: '2026-03-08T05:00:00.000Z', endsAt: '2026-03-09T04:00:00.000Z', hours: 23 });
    expect(reportInterval('2026-11-01', '2026-11-01', 'America/New_York')).toMatchObject({ startsAt: '2026-11-01T04:00:00.000Z', endsAt: '2026-11-02T05:00:00.000Z', hours: 25 });
    // Santiago skips local midnight on 2026-09-06; the day starts at the transition (01:00 local).
    expect(new Date(localDayStart('2026-09-06', 'America/Santiago')).toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(reportInterval('2026-09-06', '2026-09-06', 'America/Santiago').hours).toBe(23);
    expect(reportInterval('2026-01-01', '2026-12-31', 'America/Chicago')).toMatchObject({ days: 365, hours: 8760 });
  });

  test('rejects reversed, invalid and oversized ranges instead of truncating', () => {
    expect(() => reportInterval('2026-02-02', '2026-02-01', 'UTC')).toThrow('must not precede');
    expect(() => reportInterval('2026-02-30', '2026-03-01', 'UTC')).toThrow('real calendar dates');
    expect(() => reportInterval('2026-1-01', '2026-03-01', 'UTC')).toThrow('YYYY-MM-DD');
    expect(reportInterval('2028-01-01', '2028-12-31', 'UTC').days).toBe(MAX_REPORT_DAYS);
    expect(() => reportInterval('2027-01-01', '2028-01-02', 'UTC')).toThrow('Split the range');
  });
});

const at = (time: string) => `2026-03-08T${time}:00.000Z`;
const booking = (eventId: string, status: string, startsAt: string, endsAt: string): BookingInput => ({ eventId, status, occupancy: { startsAt, endsAt } });
// Spring-forward day in New York: 05:00Z through 04:00Z next day (23 hours).
const springDay = reportInterval('2026-03-08', '2026-03-08', 'America/New_York');
const field = {
  resourceId: 'r1',
  availability: [
    { revision: 1, effectiveFrom: '2026-03-01T00:00:00.000Z', windows: [{ startsAt: at('13:00'), endsAt: at('21:00') }] },
    // Version 2 takes over at 17:00, cutting version 1 to 13:00-17:00 (240 min) and adding 18:00-23:00 (300 min).
    { revision: 2, effectiveFrom: at('17:00'), windows: [{ startsAt: at('18:00'), endsAt: at('23:00') }] },
  ],
  closures: [{ startsAt: at('19:00'), endsAt: at('20:00') }],
  bookings: [
    booking('b1', 'completed', at('13:00'), at('14:30')),
    booking('b2', 'scheduled', at('14:00'), at('15:00')),
    booking('b3', 'cancelled', at('15:00'), at('16:00')),
    booking('b4', 'scheduled', at('19:30'), at('20:30')),
    booking('b5', 'completed', at('17:00'), at('18:00')),
    booking('b6', 'completed', at('22:30'), at('23:30')),
    booking('b7', 'completed', '2026-03-09T03:30:00.000Z', '2026-03-09T05:00:00.000Z'),
    // The shared canonical game appears once per team calendar but is one reservation.
    booking('b1', 'completed', at('13:00'), at('14:30')),
  ],
};

describe('facility booked utilization', () => {
  test('matches the hand calculation for versions, closures, overlaps and out-of-availability bookings', () => {
    const row = reduceResource(field, springDay);
    // Scheduled 540 minus 60 closed = 480 bookable.
    expect([row.availableMinutes, row.closedMinutes, row.unknownAvailabilityMinutes]).toEqual([480, 60, 0]);
    // b1 union b2 = 13:00-15:00 (120) plus b6 22:30-23:00 (30).
    expect(row.bookedMinutes).toBe(150);
    // b5 60 + b6 30 + b7 30 inside the interval.
    expect(row.outsideAvailabilityMinutes).toBe(120);
    expect(row.conflictMinutes).toBe(30);
    expect([row.bookings, row.excludedBookings, row.closureAffectedBookings]).toEqual([5, 1, 1]);
    expect(row.utilization).toEqual({ numerator: 150, denominator: 480, rate: 0.3125 });
  });

  test('sums resource-minutes, keeps unknown availability out of the ratio and shows zero availability as not enough data', () => {
    const unknown = { resourceId: 'r2', availability: [], closures: [], bookings: [booking('u1', 'completed', at('10:00'), at('11:00'))] };
    const closed = { resourceId: 'r3', closures: [{ startsAt: at('00:00'), endsAt: '2026-03-09T12:00:00.000Z' }], bookings: [],
      availability: [{ revision: 1, effectiveFrom: '2026-01-01T00:00:00.000Z', windows: [{ startsAt: at('13:00'), endsAt: at('15:00') }] }] };
    const { summary, resources } = reduceFacility([unknown, closed, field], springDay);
    expect(resources.map(row => row.resourceId)).toEqual(['r1', 'r2', 'r3']);
    expect(resources[1]).toMatchObject({ unknownAvailabilityMinutes: 1380, unknownAvailabilityBookedMinutes: 60, bookedMinutes: 0, availableMinutes: 0 });
    expect(resources[1].utilization.rate).toBeNull();
    expect(resources[2]).toMatchObject({ availableMinutes: 0, closedMinutes: 120 });
    expect(formatRate(resources[2].utilization)).toBe('Not enough data');
    // 150 / 480, not an average of per-resource percentages.
    expect(summary).toMatchObject({ resources: 3, availableMinutes: 480, bookedMinutes: 150, unknownAvailabilityBookedMinutes: 60, utilization: { rate: 0.3125 } });
  });

  test('the repeated fall-back hour holds two distinct UTC hours of bookings', () => {
    const day = reportInterval('2026-11-01', '2026-11-01', 'America/New_York');
    const row = reduceResource({
      resourceId: 'r1', closures: [],
      availability: [{ revision: 1, effectiveFrom: '2026-10-01T00:00:00.000Z', windows: [{ startsAt: day.startsAt, endsAt: day.endsAt }] }],
      // 01:00-02:00 EDT and 01:00-02:00 EST share a wall-clock label but not an instant.
      bookings: [booking('edt', 'completed', '2026-11-01T05:00:00.000Z', '2026-11-01T06:00:00.000Z'), booking('est', 'completed', '2026-11-01T06:00:00.000Z', '2026-11-01T07:00:00.000Z')],
    }, day);
    expect([row.availableMinutes, row.bookedMinutes, row.conflictMinutes, row.utilization.rate]).toEqual([1500, 120, 0, 0.08]);
  });
});

describe('report presentation helpers', () => {
  test('format rates, minutes and status notes', () => {
    expect(formatRate(ratio(1, 3))).toBe('33.3%');
    expect([formatMinutes(45), formatMinutes(120), formatMinutes(150)]).toEqual(['45 min', '2 h', '2 h 30 min']);
    expect(reportStatusNote({ state: 'complete', stale: false, staleReason: null, failure: null })).toBeNull();
    expect(reportStatusNote({ state: 'complete', stale: true, staleReason: 'attendanceCorrected', failure: null })).toContain('Rebuild');
    expect(reportStatusNote({ state: 'building', stale: false, staleReason: null, failure: null })).toContain('still calculating');
    expect(reportStatusNote({ state: 'failed', stale: false, staleReason: null, failure: { code: 'REPORT_TOO_LARGE', message: 'Choose one team.' } })).toBe('Choose one team.');
  });
});
