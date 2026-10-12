/** Story Turn's date presentation, with calendar-only values kept on their stored day. */
const dateOptions: Intl.DateTimeFormatOptions = {
  weekday: "long",
  month: "short",
  day: "numeric",
};
export function formatCalendarDate(value: string | Date): string {
  const date =
    typeof value === "string" ? new Date(`${value}T12:00:00Z`) : value;
  return new Intl.DateTimeFormat("en-US", {
    ...dateOptions,
    timeZone: "UTC",
  }).format(date);
}
export function formatDateTime(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const day = new Intl.DateTimeFormat("en-US", dateOptions).format(date);
  const time = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  return `${day} at ${time}`;
}
