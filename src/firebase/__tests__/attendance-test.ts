const mockRead = jest.fn();
const mockCallable = jest.fn(() => mockRead);
const mockRun = jest.fn();
jest.mock("firebase/functions", () => ({
  httpsCallable: (...args: unknown[]) => (mockCallable as Function)(...args),
}));
jest.mock("firebase/firestore", () => ({
  collection: () => "receipts",
  doc: () => ({ id: "stable-request-id" }),
}));
jest.mock("../commands", () => ({
  runCommand: (...args: unknown[]) => mockRun(...args),
}));
import {
  attendanceRequestId,
  getEventAttendance,
  recordEventAttendance,
  getAttendanceHistory,
} from "../attendance";
test("staff attendance adapters preserve team, participant, cursor and stable request identity", async () => {
  mockRead.mockResolvedValue({ data: { items: [], nextCursor: "p" } });
  expect(await getEventAttendance("e", "t")).toEqual({
    items: [],
    nextCursor: "p",
  });
  expect(mockRead).toHaveBeenLastCalledWith({
    eventId: "e",
    teamId: "t",
    cursor: null,
  });
  await getEventAttendance("e", "t", "p");
  expect(mockRead).toHaveBeenLastCalledWith({
    eventId: "e",
    teamId: "t",
    cursor: "p",
  });
  await getAttendanceHistory("e", "t", "p");
  expect(mockRead).toHaveBeenLastCalledWith({
    eventId: "e",
    teamId: "t",
    participantId: "p",
    cursor: null,
  });
  await getAttendanceHistory("e", "t", "p", "r");
  expect(mockRead).toHaveBeenLastCalledWith({
    eventId: "e",
    teamId: "t",
    participantId: "p",
    cursor: "r",
  });
  await recordEventAttendance({ participantId: "p" }, attendanceRequestId());
  expect(mockRun).toHaveBeenCalledWith(
    "recordEventAttendance",
    { participantId: "p" },
    "stable-request-id",
  );
  mockRead.mockRejectedValueOnce({ code: "functions/permission-denied" });
  await expect(getEventAttendance("e", "t")).rejects.toEqual({
    code: "functions/permission-denied",
  });
});
