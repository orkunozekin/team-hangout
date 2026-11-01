import { eventCardContent } from '../eventCard';

const base = {
  title: 'Maple Foxes vs River Otters',
  type: 'match' as const,
  status: 'scheduled' as const,
  startsAt: '2026-10-03T23:00:00.000Z',
  endsAt: '2026-10-04T00:30:00.000Z',
  timeZone: 'America/Chicago',
  teamNames: ['Maple Foxes', 'River Otters'],
};
const lines = (content: ReturnType<typeof eventCardContent>) => Object.values(content).filter(Boolean).join('\n');

test('zone appears once as the abbreviation and the schedule version is never shown', () => {
  const content = eventCardContent({ ...base, status: 'postponed' });
  expect(content.when).toBe('Saturday, Oct 3 · 6:00 PM CDT – 7:30 PM CDT');
  expect(lines(content)).not.toMatch(/America\/Chicago|version/i);
  expect(content.statusLabel).toBe('Postponed: awaiting a new schedule');
  expect(eventCardContent(base).statusLabel).toBeNull();
});

test('team line is dropped when the title names every team and kept otherwise', () => {
  expect(eventCardContent(base).teams).toBeNull();
  expect(eventCardContent({ ...base, title: 'Saturday match' }).teams).toBe('Maple Foxes vs River Otters');
  expect(eventCardContent({ ...base, title: 'Maple Foxes home game' }).teams).toBe('Maple Foxes vs River Otters');
  expect(eventCardContent({ ...base, type: 'practice', title: 'Maple Foxes practice', teamNames: ['Maple Foxes'] }).teams).toBeNull();
});

test('org and season context only renders when the caller provides disambiguating labels', () => {
  expect(eventCardContent(base).context).toBeNull();
  expect(eventCardContent({ ...base, contexts: ['Maple Valley · Fall 2026', 'Maple Valley · Fall 2026'] }).context).toBe('Maple Valley · Fall 2026');
});

test('a cross-zone event shows display time plus the event local time, each with its own zone', () => {
  const content = eventCardContent(base, 'America/New_York');
  expect(content.when).toBe('Saturday, Oct 3 · 7:00 PM EDT – 8:30 PM EDT');
  expect(content.eventLocalWhen).toBe('Local time: Saturday, Oct 3 · 6:00 PM CDT – 7:30 PM CDT');
  expect(eventCardContent(base, 'America/Chicago').eventLocalWhen).toBeNull();
});

test('DST fold times stay distinguishable by abbreviation', () => {
  const content = eventCardContent({ ...base, startsAt: '2026-11-01T06:30:00.000Z', endsAt: '2026-11-01T07:30:00.000Z' });
  expect(content.when).toMatch(/1:30 AM CDT – 1:30 AM CST/);
});

test('legacy events fall back to their split date and time', () => {
  expect(eventCardContent({ title: 'Practice', type: 'practice', legacyWhen: 'Sat, Oct 3 · 18:00' }).when).toBe('Sat, Oct 3 · 18:00');
});
