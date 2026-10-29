const mockRead = jest.fn();
const mockCallable = jest.fn((..._args: unknown[]) => mockRead);
const mockRun = jest.fn();
jest.mock("firebase/functions", () => ({
  httpsCallable: (...args: unknown[]) => mockCallable(...args),
}));
jest.mock("firebase/firestore", () => ({
  collection: () => "receipts",
  doc: () => ({ id: "stable-request-id" }),
}));
jest.mock("../commands", () => ({
  runCommand: (...args: unknown[]) => mockRun(...args),
}));
import { getReportRun, listTeamReports, reportRequestId, requestTeamAttendanceReport } from "../reports";

test("report reads name only the organization and the team or run", async () => {
  mockRead.mockResolvedValue({ data: { items: [], nextCursor: null } });
  expect(await listTeamReports("o", "t")).toEqual({ items: [], nextCursor: null });
  expect(mockCallable).toHaveBeenLastCalledWith(expect.anything(), "listReportRuns");
  expect(mockRead).toHaveBeenLastCalledWith({ orgId: "o", teamId: "t" });
  await getReportRun("o", "r");
  expect(mockCallable).toHaveBeenLastCalledWith(expect.anything(), "getReportRun");
  expect(mockRead).toHaveBeenLastCalledWith({ orgId: "o", runId: "r" });
});

test("a team report request carries explicit filters and a caller-held request ID", async () => {
  expect(reportRequestId()).toBe("stable-request-id");
  await requestTeamAttendanceReport("o", { programId: "p", seasonId: "s", teamId: "t" }, { fromDate: "2026-10-01", toDate: "2026-10-30" }, "r1");
  expect(mockRun).toHaveBeenLastCalledWith("requestReport",
    { orgId: "o", filters: { kind: "attendance", programId: "p", seasonId: "s", teamId: "t", fromDate: "2026-10-01", toDate: "2026-10-30" } }, "r1");
});
