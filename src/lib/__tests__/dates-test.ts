import { formatCalendarDate, formatDateTime } from "../../../shared/dates";

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
