import { agendaTime, dayBoundary } from "../agendaTime";
test("calendar windows follow 23 and 25 hour DST days", () => {
  expect(dayBoundary("2026-03-08", "America/Chicago")).toBe(
    "2026-03-08T06:00:00.000Z",
  );
  expect(dayBoundary("2026-03-09", "America/Chicago")).toBe(
    "2026-03-09T05:00:00.000Z",
  );
  expect(dayBoundary("2026-11-01", "America/Chicago")).toBe(
    "2026-11-01T05:00:00.000Z",
  );
  expect(dayBoundary("2026-11-02", "America/Chicago")).toBe(
    "2026-11-02T06:00:00.000Z",
  );
  expect(dayBoundary("2026-10-04", "Australia/Lord_Howe")).toBe(
    "2026-10-03T13:30:00.000Z",
  );
});
test("fold instants have distinguishable offsets and overnight events retain end date", () => {
  expect(
    agendaTime(
      "2026-11-01T06:30:00.000Z",
      "2026-11-01T07:30:00.000Z",
      "America/Chicago",
    ),
  ).toMatch(/1:30 AM CDT.*1:30 AM CST/);
  expect(
    agendaTime(
      "2026-11-02T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
      "America/Chicago",
    ),
  ).toContain("Monday, Nov 2");
  expect(() => dayBoundary("2026-02-30", "America/Chicago")).toThrow();
  expect(() => dayBoundary("2011-12-30", "Pacific/Apia")).toThrow();
});
