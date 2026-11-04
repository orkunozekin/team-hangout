const mockRead = jest.fn(),
  mockCallable = jest.fn(() => mockRead),
  mockRun = jest.fn();
jest.mock("firebase/functions", () => ({
  httpsCallable: (...args: unknown[]) => (mockCallable as Function)(...args),
}));
jest.mock("../commands", () => ({
  runCommand: (...args: unknown[]) => mockRun(...args),
}));
import {
  getParticipantCheckIn,
  checkInParticipant,
  setEventCheckInPolicy,
} from "../checkIn";
test("participant scoped read and stable attendance command adapters", async () => {
  mockRead.mockResolvedValue({ data: { status: "unknown" } });
  expect(await getParticipantCheckIn("e", "p")).toEqual({ status: "unknown" });
  expect(mockRead).toHaveBeenCalledWith({ eventId: "e", participantId: "p" });
  await checkInParticipant({ participantId: "p", method: "simple" }, "stable");
  expect(mockRun).toHaveBeenCalledWith(
    "checkInParticipant",
    { participantId: "p", method: "simple" },
    "stable",
  );
  const policy = {
    beforeMinutes: 40,
    afterMinutes: 120,
    radiusMeters: 500,
    locationEnabled: true,
  };
  await setEventCheckInPolicy("e", 3, policy);
  expect(mockRun).toHaveBeenCalledWith("setEventCheckInPolicy", {
    eventId: "e",
    expectedRevision: 3,
    policy,
  });
});
