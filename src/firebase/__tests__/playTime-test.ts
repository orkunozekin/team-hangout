const mockRead = jest.fn();
const mockCallable = jest.fn((..._args: unknown[]) => mockRead);
const mockRun = jest.fn();
jest.mock("firebase/functions", () => ({
  httpsCallable: (...args: unknown[]) => mockCallable(...args),
}));
jest.mock("../commands", () => ({
  runCommand: (...args: unknown[]) => mockRun(...args),
}));
import { finalizePlaySession, getPlaySession, recordPlayAction } from "../playTime";

test("playing-time reads name only the event and team", async () => {
  mockRead.mockResolvedValue({ data: { status: "notStarted" } });
  expect(await getPlaySession("e", "t")).toEqual({ status: "notStarted" });
  expect(mockCallable).toHaveBeenLastCalledWith(expect.anything(), "getPlaySession");
  expect(mockRead).toHaveBeenLastCalledWith({ eventId: "e", teamId: "t" });
});

test("playing-time mutations use the Phase 3 envelope and never send a client clock", async () => {
  await recordPlayAction("o", "e", "t", 4, { kind: "substitute", unitId: "starting", outParticipantId: "a", inParticipantId: "b" }, "r1");
  expect(mockRun).toHaveBeenLastCalledWith(
    "recordPlayAction",
    { orgId: "o", resourceId: "e", expectedRevision: 4, payload: { teamId: "t", kind: "substitute", unitId: "starting", outParticipantId: "a", inParticipantId: "b" } },
    "r1",
  );
  await finalizePlaySession("o", "e", "t", 9);
  expect(mockRun).toHaveBeenLastCalledWith(
    "finalizePlaySession",
    { orgId: "o", resourceId: "e", expectedRevision: 9, payload: { teamId: "t" } },
    undefined,
  );
});
