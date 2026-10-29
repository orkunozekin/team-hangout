const mockRead = jest.fn();
const mockCallable = jest.fn((..._args: unknown[]) => mockRead);
const mockRun = jest.fn();
jest.mock("firebase/functions", () => ({
  httpsCallable: (...args: unknown[]) => mockCallable(...args),
}));
jest.mock("../commands", () => ({
  runCommand: (...args: unknown[]) => mockRun(...args),
}));
import { getEventResults, getEventStandings, proposeResult } from "../competition";

test("event results read only the event and coaching team", async () => {
  mockRead.mockResolvedValue({ data: { competitions: [] } });
  expect(await getEventResults("e", "t")).toEqual({ competitions: [] });
  expect(mockCallable).toHaveBeenLastCalledWith(expect.anything(), "getEventResults");
  expect(mockRead).toHaveBeenLastCalledWith({ eventId: "e", teamId: "t" });
});

test("proposals use the Phase 3 envelope keyed by competition", async () => {
  const result = { outcome: "played" as const, homeScore: 2, awayScore: 1, forfeitingTeamId: null, winnerTeamId: null, decider: null };
  await proposeResult("o", "c", "e", "t", 3, result, "r1");
  expect(mockRun).toHaveBeenLastCalledWith(
    "proposeResult",
    { orgId: "o", resourceId: "c", expectedRevision: 3, payload: { eventId: "e", teamId: "t", result } },
    "r1",
  );
});

test("event standings send only the viewer scope and optional paging pins", async () => {
  mockRead.mockResolvedValue({ data: { competitions: [], standings: null } });
  await getEventStandings("e", "t");
  expect(mockCallable).toHaveBeenLastCalledWith(expect.anything(), "getEventStandings");
  expect(mockRead).toHaveBeenLastCalledWith({ eventId: "e", teamId: "t" });
  await getEventStandings("e", "t", { competitionId: "c", generationId: "g", cursor: "0050" });
  expect(mockRead).toHaveBeenLastCalledWith({ eventId: "e", teamId: "t", competitionId: "c", generationId: "g", cursor: "0050" });
});
