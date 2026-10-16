/** Story Turn's date presentation, with calendar-only values kept on their stored day. */
const dateOptions: Intl.DateTimeFormatOptions = {
  weekday: "long",
  month: "short",
  day: "numeric",
};
export function formatCalendarDate(value: string | Date): string {
  const date =
    typeof value === "string" ? new Date(`${value}T12:00:00Z`) : value;
  if (!Number.isFinite(date.getTime())) return "Invalid date";
  return new Intl.DateTimeFormat("en-US", {
    ...dateOptions,
    timeZone: "UTC",
  }).format(date);
}
export function formatDateTime(
  value: string | Date,
  timeZone?: string,
): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) return "Invalid date and time";
  const day = new Intl.DateTimeFormat("en-US", {
    ...dateOptions,
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    ...(timeZone ? { timeZone, timeZoneName: "short" as const } : {}),
  }).format(date);
  return `${day} at ${time}`;
}

/** Format a stored wall-clock value without converting its day or timezone. */
export function formatClockTime(value: string): string {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return value;
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]} ${hour < 12 ? "AM" : "PM"}`;
}
