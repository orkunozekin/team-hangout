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
import { getLineup, getLineupView, lineupRequestId, publishLineup, saveLineup } from "../lineups";

test("lineup reads name the event and team, and household views pass a participant only when given", async () => {
  mockRead.mockResolvedValue({ data: { state: "unpublished" } });
  await getLineup("e", "t");
  expect(mockCallable).toHaveBeenLastCalledWith(expect.anything(), "getLineup");
  expect(mockRead).toHaveBeenLastCalledWith({ eventId: "e", teamId: "t" });
  expect(await getLineupView("e", "t")).toEqual({ state: "unpublished" });
  expect(mockRead).toHaveBeenLastCalledWith({ eventId: "e", teamId: "t" });
  await getLineupView("e", "t", "p");
  expect(mockRead).toHaveBeenLastCalledWith({ eventId: "e", teamId: "t", participantId: "p" });
});

test("lineup mutations use the Phase 3 envelope with a caller-held request ID", async () => {
  expect(lineupRequestId()).toBe("stable-request-id");
  const payload = { teamId: "t", sportPresetId: "soccer" as const, units: [], bench: ["b", "a"], note: "" };
  await saveLineup("o", "e", 2, payload, "r1");
  expect(mockRun).toHaveBeenLastCalledWith("saveLineup", { orgId: "o", resourceId: "e", expectedRevision: 2, payload }, "r1");
  await publishLineup("o", "e", "t", 3, "retract", "r2");
  expect(mockRun).toHaveBeenLastCalledWith(
    "publishLineup",
    { orgId: "o", resourceId: "e", expectedRevision: 3, payload: { teamId: "t", action: "retract" } },
    "r2",
  );
});
