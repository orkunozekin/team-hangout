import {
  TeamEvent,
} from '../types/models';

function eventSortKey(event: TeamEvent): string {
  if (event.schemaVersion === 2 && event.startsAt) return new Date(event.startsAt).toISOString();
  const date = event.date instanceof Date
    ? event.date
    : new Date(event.date);
  const yyyy = date.getUTCFullYear().toString().padStart(4, '0');
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = date.getUTCDate().toString().padStart(2, '0');
  const time = event.time || '00:00';
  return `${yyyy}-${mm}-${dd}T${time}`;
}

export function sortEventsByDateTime(
  events: TeamEvent[],
  direction: 'asc' | 'desc' = 'asc',
): TeamEvent[] {
  const sorted = [...events].sort((a, b) => {
    const keyA = eventSortKey(a);
    const keyB = eventSortKey(b);
    if (keyA < keyB) return -1;
    if (keyA > keyB) return 1;
    return a.title.localeCompare(b.title);
  });

  return direction === 'asc' ? sorted : sorted.reverse();
}

export function applyScheduleView(
  events: TeamEvent[],
  filter: 'all' | 'practice' | 'match',
  direction: 'asc' | 'desc' = 'asc',
): TeamEvent[] {
  const filtered =
    filter === 'all'
      ? events
      : events.filter((event) => event.type === filter);

  return sortEventsByDateTime(filtered, direction);
}
