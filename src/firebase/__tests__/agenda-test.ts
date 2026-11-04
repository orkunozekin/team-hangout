import { listHouseholdAgenda } from "../agenda";
import { httpsCallable } from "firebase/functions";
jest.mock("firebase/functions", () => ({ httpsCallable: jest.fn() }));
test("canonical agenda adapter preserves instants, filters and server cursor without legacy conversion", async () => {
  const payload = {
    from: "2026-11-01T05:00:00.000Z",
    to: "2026-11-02T06:00:00.000Z",
    participantRefs: [{ orgId: "org", participantId: "child" }],
    cursor: "opaque-cursor",
  };
  const data = {
    items: [
      {
        startsAt: "2026-11-01T06:30:00.000Z",
        endsAt: "2026-11-01T07:30:00.000Z",
        timeZone: "America/Chicago",
      },
    ],
    nextCursor: "next",
    accessVersion: "version",
  };
  const execute = jest.fn().mockResolvedValue({ data });
  (httpsCallable as jest.Mock).mockReturnValue(execute);
  expect(await listHouseholdAgenda(payload)).toBe(data);
  expect(httpsCallable).toHaveBeenCalledWith({}, "listHouseholdAgenda");
  expect(execute).toHaveBeenCalledWith(payload);
  execute.mockRejectedValueOnce({ code: "functions/permission-denied" });
  await expect(listHouseholdAgenda(payload)).rejects.toEqual({
    code: "functions/permission-denied",
  });
});
