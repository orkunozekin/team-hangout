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
import { claimVolunteerSlot, getEventVolunteers, releaseVolunteerSlot, saveVolunteerSlot, volunteerRequestId } from "../volunteers";

test("volunteer reads name only the event and team", async () => {
  mockRead.mockResolvedValue({ data: { slots: [] } });
  expect(await getEventVolunteers("e", "t")).toEqual({ slots: [] });
  expect(mockCallable).toHaveBeenLastCalledWith(expect.anything(), "getEventVolunteers");
  expect(mockRead).toHaveBeenLastCalledWith({ eventId: "e", teamId: "t" });
});

test("volunteer mutations use the Phase 3 envelope with a caller-held request ID", async () => {
  expect(volunteerRequestId()).toBe("stable-request-id");
  await saveVolunteerSlot("o", "e", "t", 0, { kind: "snacks", title: "Oranges", capacity: 2, claimDeadline: null }, "r1");
  expect(mockRun).toHaveBeenLastCalledWith("saveVolunteerSlot",
    { orgId: "o", resourceId: "e", expectedRevision: 0, payload: { teamId: "t", kind: "snacks", title: "Oranges", capacity: 2, claimDeadline: null } }, "r1");
  await claimVolunteerSlot("o", "e", "t", "s", "Sam R.", "r2");
  expect(mockRun).toHaveBeenLastCalledWith("claimVolunteerSlot",
    { orgId: "o", resourceId: "e", expectedRevision: null, payload: { teamId: "t", slotId: "s", displayAlias: "Sam R.", showAlias: true } }, "r2");
  await releaseVolunteerSlot("o", "e", "t", "s", "r3");
  expect(mockRun).toHaveBeenLastCalledWith("releaseVolunteerSlot",
    { orgId: "o", resourceId: "e", expectedRevision: null, payload: { teamId: "t", slotId: "s" } }, "r3");
  await releaseVolunteerSlot("o", "e", "t", "s", "r4", "k");
  expect(mockRun).toHaveBeenLastCalledWith("releaseVolunteerSlot",
    { orgId: "o", resourceId: "e", expectedRevision: null, payload: { teamId: "t", slotId: "s", assigneeKey: "k" } }, "r4");
});
