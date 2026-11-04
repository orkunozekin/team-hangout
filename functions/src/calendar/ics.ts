/** RFC 5545 TEXT and UTF-8 octet folding. Input is an allowlisted agenda response. */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
export function foldLine(line: string): string {
  const rows: string[] = [];
  let row = "",
    size = 0;
  for (const char of line) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (size + bytes > 75) {
      rows.push(row);
      row = " ";
      size = 1;
    }
    row += char;
    size += bytes;
  }
  rows.push(row);
  return rows.join("\r\n");
}
const utc = (iso: string) =>
  new Date(iso)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
type Event = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  updatedAt: string;
  revision: number;
  teams: { name: string }[];
  location: { name: string; address?: string } | null;
  participants: { displayName: string }[];
};
export function encodeCalendar(
  events: Event[],
  domain: string,
  names = false,
): string {
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain))
    throw new Error("Invalid calendar UID domain.");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Team Hangout//Private Calendar//EN",
    "CALSCALE:GREGORIAN",
  ];
  for (const e of events) {
    if (
      !/^[A-Za-z0-9_-]+$/.test(e.id) ||
      !Number.isSafeInteger(e.revision) ||
      e.revision < 0 ||
      e.revision > 2147483647
    )
      throw new Error("Invalid calendar event.");
    const description = [`Teams: ${e.teams.map((t) => t.name).join(", ")}`];
    if (names)
      description.push(
        `Participants: ${e.participants.map((p) => p.displayName).join(", ")}`,
      );
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.id}@${domain}`,
      `DTSTAMP:${utc(e.updatedAt)}`,
      `LAST-MODIFIED:${utc(e.updatedAt)}`,
      `SEQUENCE:${e.revision}`,
      `DTSTART:${utc(e.startsAt)}`,
      `DTEND:${utc(e.endsAt)}`,
      `SUMMARY:${escapeText(e.title)}`,
      `DESCRIPTION:${escapeText(description.join("\n"))}`,
    );
    if (e.location)
      lines.push(
        `LOCATION:${escapeText([e.location.name, e.location.address].filter(Boolean).join(", "))}`,
      );
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
