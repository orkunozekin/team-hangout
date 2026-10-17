export type Interval = { startsAt: string; endsAt: string };
export const millis = (value: string) => Date.parse(value);
export function overlaps(a: Interval, b: Interval) {
  return millis(a.startsAt) < millis(b.endsAt) && millis(b.startsAt) < millis(a.endsAt);
}
export function occupancy(interval: Interval, setupMinutes: number, cleanupMinutes: number): Interval {
  return { startsAt: new Date(millis(interval.startsAt) - setupMinutes * 60000).toISOString(),
    endsAt: new Date(millis(interval.endsAt) + cleanupMinutes * 60000).toISOString() };
}
export function contains(windows: Interval[], interval: Interval) {
  let covered = millis(interval.startsAt);
  for (const window of [...windows].sort((a, b) => millis(a.startsAt) - millis(b.startsAt))) {
    if (millis(window.startsAt) > covered) break;
    if (millis(window.endsAt) > covered) covered = millis(window.endsAt);
    if (covered >= millis(interval.endsAt)) return true;
  }
  return false;
}
