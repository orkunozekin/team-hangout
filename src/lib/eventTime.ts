/** Resolve a wall-clock time without silently shifting DST gaps or choosing a repeated hour. */
export function eventInstant(date: string, time: string, timeZone: string, occurrence?: 'earlier' | 'later'): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Enter a valid date and time.');
  const wall = Date.parse(`${date}T${time}:00.000Z`);
  if (!Number.isFinite(wall) || new Date(wall).toISOString().slice(0, 10) !== date) throw new Error('Enter a valid date.');
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const matches: number[] = [];
  // Current supported IANA offsets are multiples of 15 minutes, bounded by UTC-12/UTC+14.
  for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
    const instant = wall + offset * 60000;
    const parts = formatter.formatToParts(new Date(instant));
    const get = (name: string) => parts.find(part => part.type === name)!.value;
    if (`${get('year')}-${get('month')}-${get('day')}` === date && `${get('hour')}:${get('minute')}` === time) matches.push(instant);
  }
  if (!matches.length) throw new Error('This local time does not exist because clocks change. Choose another time.');
  if (matches.length > 1 && !occurrence) throw new Error('This local time occurs twice. Choose the first or second occurrence below.');
  return new Date(occurrence === 'later' ? matches[matches.length - 1] : matches[0]).toISOString();
}
export function eventInterval(date: string, time: string, timeZone: string, duration: string, occurrence?: 'earlier' | 'later') {
  const minutes = Number(duration);
  if (!/^\d+$/.test(duration) || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('Duration must be 1 through 1440 minutes.');
  const startsAt = eventInstant(date, time, timeZone, occurrence);
  return { startsAt, endsAt: new Date(Date.parse(startsAt) + minutes * 60000).toISOString(), timeZone };
}
