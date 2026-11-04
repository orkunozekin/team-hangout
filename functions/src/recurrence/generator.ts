export type SeriesFields = {
  title: string;
  startsOn: string;
  endsOn: string;
  weekdays: number[];
  localTime: string;
  timeZone: string;
  durationMinutes: number;
  exclusions: string[];
  offsets: Record<string, number>;
  facilityId: string | null;
  resourceId: string | null;
};
export type Occurrence = {
  id: string;
  localDate: string;
  localTime: string;
  startsAt: string | null;
  endsAt: string | null;
  offsetMinutes: number | null;
  choices: { startsAt: string; offsetMinutes: number }[];
  issue: string | null;
};
export function calendarDate(value: string) {
  if (
    !/^20\d\d-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    throw new Error("Use a valid calendar date between 2000 and 2099.");
  return value;
}
/** Calendar iteration is independent of the timezone's elapsed day length. */
export function nextDate(date: string) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
export function generateOccurrences(
  seriesId: string,
  fields: SeriesFields,
): Occurrence[] {
  calendarDate(fields.startsOn);
  calendarDate(fields.endsOn);
  if (
    fields.endsOn < fields.startsOn ||
    (Date.parse(fields.endsOn) - Date.parse(fields.startsOn)) / 86400000 >= 112
  )
    throw new Error("Review a finite range of at most 16 weeks.");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(fields.localTime))
    throw new Error("Use a valid local time.");
  if (
    !fields.weekdays.length ||
    fields.weekdays.some((n) => !Number.isInteger(n) || n < 0 || n > 6)
  )
    throw new Error("Choose at least one weekday.");
  if (
    !Number.isInteger(fields.durationMinutes) ||
    fields.durationMinutes < 1 ||
    fields.durationMinutes > 1440
  )
    throw new Error("Duration must be 1 through 1440 minutes.");
  if (!/^[A-Za-z][A-Za-z0-9_+\/-]*$/.test(fields.timeZone))
    throw new Error("Use an IANA timezone.");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: fields.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const wallAt = (instant: number) => {
    const parts = formatter.formatToParts(new Date(instant));
    const get = (key: string) => parts.find((p) => p.type === key)!.value;
    return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:00.000Z`;
  };
  const dates: string[] = [];
  for (let date = fields.startsOn; date <= fields.endsOn; date = nextDate(date))
    if (fields.weekdays.includes(new Date(`${date}T00:00:00Z`).getUTCDay()))
      dates.push(date);
  if (dates.length > 64)
    throw new Error(
      "Review at most 64 occurrences at once. Narrow the range or weekdays.",
    );
  if (
    fields.exclusions.some((date) => !dates.includes(calendarDate(date))) ||
    new Set(fields.exclusions).size !== fields.exclusions.length
  )
    throw new Error("Exclusions must be unique scheduled dates in this range.");
  if (
    Object.keys(fields.offsets).some(
      (date) => !dates.includes(date) || fields.exclusions.includes(date),
    )
  )
    throw new Error("Offset choices must refer to included scheduled dates.");
  return dates
    .filter((date) => !fields.exclusions.includes(date))
    .map((date) => {
      const wall = Date.parse(`${date}T${fields.localTime}:00.000Z`);
      // Discover actual offsets near this date, including half-hour changes and date-line shifts.
      const offsets = new Set<number>();
      for (let h = -48; h <= 48; h += 6) {
        const instant = wall + h * 3600000;
        offsets.add((Date.parse(wallAt(instant)) - instant) / 60000);
      }
      const choices = [...offsets]
        .map((offsetMinutes) => ({
          offsetMinutes,
          startsAt: new Date(wall - offsetMinutes * 60000).toISOString(),
        }))
        .filter(
          (c) =>
            wallAt(Date.parse(c.startsAt)) ===
            `${date}T${fields.localTime}:00.000Z`,
        )
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      const requested = fields.offsets[date];
      const chosen =
        requested !== undefined
          ? choices.find((c) => c.offsetMinutes === requested)
          : choices.length === 1
            ? choices[0]
            : undefined;
      const issue = !choices.length
        ? "This local time does not exist. Change the time or explicitly exclude this date."
        : !chosen
          ? "Choose an explicit UTC offset for this repeated local time."
          : null;
      return {
        id: `${seriesId}_${date}_practice`,
        localDate: date,
        localTime: fields.localTime,
        startsAt: chosen?.startsAt ?? null,
        endsAt: chosen
          ? new Date(
              Date.parse(chosen.startsAt) + fields.durationMinutes * 60000,
            ).toISOString()
          : null,
        offsetMinutes: chosen?.offsetMinutes ?? null,
        choices,
        issue,
      };
    });
}
