import { eventInstant, eventInterval } from '../eventTime';
test('local time resolves in the displayed timezone and duration crosses midnight', () => {
  expect(eventInterval('2026-10-20', '23:30', 'America/Chicago', '90')).toEqual({ startsAt: '2026-10-21T04:30:00.000Z', endsAt: '2026-10-21T06:00:00.000Z', timeZone: 'America/Chicago' });
  expect(eventInstant('2026-10-20', '18:00', 'Asia/Kathmandu')).toBe('2026-10-20T12:15:00.000Z');
});
test('DST gap rejects and repeated local time requires an explicit occurrence', () => {
  expect(() => eventInstant('2026-03-08', '02:30', 'America/Chicago')).toThrow('does not exist');
  expect(() => eventInstant('2026-11-01', '01:30', 'America/Chicago')).toThrow('occurs twice');
  expect(eventInstant('2026-11-01', '01:30', 'America/Chicago', 'earlier')).toBe('2026-11-01T06:30:00.000Z');
  expect(eventInstant('2026-11-01', '01:30', 'America/Chicago', 'later')).toBe('2026-11-01T07:30:00.000Z');
});
test('invalid dates and durations fail without guessing', () => {
  expect(() => eventInstant('2026-02-30', '12:00', 'UTC')).toThrow('valid date');
  for (const duration of ['', '0', '1.5', '1441', 'x']) expect(() => eventInterval('2026-10-20', '12:00', 'UTC', duration)).toThrow('Duration');
});
