/** Local calendar boundaries are converted to instants, including 23/25-hour DST days. */
export function dateInZone(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
export function addDays(day: string, days: number): string {
  const value = new Date(`${day}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function dayBoundary(day: string, timeZone: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) !== day
  )
    throw new Error("Use YYYY-MM-DD.");
  const nominal = Date.parse(`${day}T00:00:00.000Z`);
  let low = nominal - 36 * 3600000,
    high = nominal + 36 * 3600000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (dateInZone(new Date(middle), timeZone) < day) low = middle + 1;
    else high = middle;
  }
  if (dateInZone(new Date(low), timeZone) !== day)
    throw new Error("This date does not exist in the selected timezone.");
  return new Date(low).toISOString();
}
export function agendaTime(
  startsAt: string,
  endsAt: string,
  timeZone: string,
): string {
  const date = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "short",
    day: "numeric",
  });
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const start = new Date(startsAt),
    end = new Date(endsAt);
  return `${date.format(start)} · ${time.format(start)} – ${dateInZone(start, timeZone) !== dateInZone(end, timeZone) ? `${date.format(end)} · ` : ""}${time.format(end)}`;
}
