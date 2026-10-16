import {
  formatCalendarDate,
  formatDateTime,
  formatClockTime,
} from "../../../shared/dates";

test("calendar dates preserve their stored day and use Story Turn presentation", () => {
  expect(formatCalendarDate("2026-10-12")).toBe("Monday, Oct 12");
  expect(formatCalendarDate(new Date("2026-10-12T00:00:00Z"))).toBe(
    "Monday, Oct 12",
  );
});
test("timestamp labels include the same date style and readable clock time", () => {
  expect(formatDateTime(new Date(2026, 9, 12, 18, 30))).toBe(
    "Monday, Oct 12 at 6:30 PM",
  );
});

test("event-zone timestamps retain midnight and DST offsets with readable clocks", () => {
  expect(formatDateTime("2035-01-03T00:00:00.000Z", "America/Chicago")).toBe(
    "Tuesday, Jan 2 at 6:00 PM CST",
  );
  expect(formatDateTime("2026-11-01T06:30:00.000Z", "America/Chicago")).toBe(
    "Sunday, Nov 1 at 1:30 AM CDT",
  );
  expect(formatDateTime("2026-11-01T07:30:00.000Z", "America/Chicago")).toBe(
    "Sunday, Nov 1 at 1:30 AM CST",
  );
  expect(formatClockTime("00:05")).toBe("12:05 AM");
  expect(formatClockTime("18:30")).toBe("6:30 PM");
});

test("partially edited timestamps remain renderable", () => {
  expect(formatDateTime(undefined)).toBe("Date and time unavailable");
  expect(formatDateTime("2035-01-02T1", "UTC")).toBe("Invalid date and time");
});
