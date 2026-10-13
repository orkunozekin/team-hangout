import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import HouseholdAgenda from "../HouseholdAgenda";
import { listHouseholdAgenda } from "../../firebase/agenda";
jest.mock("../../firebase/agenda", () => ({ listHouseholdAgenda: jest.fn() }));
const api = listHouseholdAgenda as jest.Mock;
const participants = [
  { orgId: "org", participantId: "a", displayName: "Jamie" },
  { orgId: "org", participantId: "b", displayName: "Casey" },
];
const team = {
  id: "team",
  orgId: "org",
  name: "Stars",
  organizationName: "Demo Club",
  seasonId: "fall",
  seasonName: "Fall",
  archived: false,
  participants,
};
const event = {
  id: "event",
  orgId: "org",
  title: "Sibling practice",
  type: "practice",
  startsAt: "2026-11-01T06:30:00.000Z",
  endsAt: "2026-11-01T07:30:00.000Z",
  timeZone: "America/Chicago",
  teams: [team],
  participants,
  location: { name: "Demo field" },
};
const page = {
  items: [event],
  teams: [team],
  accessVersion: "version",
  nextCursor: null,
  setupRequired: false,
};
beforeEach(() => {
  jest.clearAllMocks();
  api.mockResolvedValue(page);
});
test("deduplicated sibling card, filters and timezone are sent to server", async () => {
  await render(<HouseholdAgenda refresh={0} />);
  await screen.findByText("Jamie · Casey");
  expect(screen.getAllByText("Sibling practice")).toHaveLength(1);
  await fireEvent.press(screen.getByText("Calendar filters"));
  await fireEvent.press(screen.getByText("Jamie"));
  await waitFor(() =>
    expect(api).toHaveBeenLastCalledWith(
      expect.objectContaining({
        participantRefs: [{ orgId: "org", participantId: "a" }],
      }),
    ),
  );
  await screen.findByText("Jamie");
  await fireEvent.changeText(
    screen.getByLabelText("Display timezone"),
    "America/Chicago",
  );
  await fireEvent.changeText(
    screen.getByLabelText("Calendar first day"),
    "2026-11-01",
  );
  await fireEvent.press(screen.getByText("Apply dates and timezone"));
  await waitFor(() =>
    expect(api).toHaveBeenLastCalledWith(
      expect.objectContaining({
        from: "2026-11-01T05:00:00.000Z",
        to: "2026-12-01T06:00:00.000Z",
      }),
    ),
  );
  await screen.findByText(/1:30 AM CDT.*1:30 AM CST/);
});
test("permission change while paging discards all cards and stale filters are removed on reload", async () => {
  api.mockResolvedValueOnce({ ...page, nextCursor: "cursor" });
  const denied = jest.fn();
  await render(<HouseholdAgenda refresh={0} onAccessDenied={denied} />);
  await screen.findByText("Sibling practice");
  api.mockRejectedValueOnce({
    code: "functions/failed-precondition",
    details: { domainCode: "AGENDA_CHANGED" },
  });
  await fireEvent.press(screen.getByText("Load more events"));
  await screen.findByText(
    "Permission removed or agenda access changed. Reload to see your current household.",
  );
  expect(screen.queryByText("Sibling practice")).toBeNull();
  expect(denied).toHaveBeenCalledTimes(1);
  api.mockResolvedValue({ ...page, teams: [], items: [] });
  await fireEvent.press(screen.getByText("Reload calendar"));
  await screen.findByText(
    "No published events match this date window and these filters.",
  );
});
test("delayed earlier filter response cannot restore old cards; unavailable selections reset", async () => {
  await render(<HouseholdAgenda refresh={0} />);
  await screen.findByText("Sibling practice");
  await fireEvent.press(screen.getByText("Calendar filters"));
  let finish: (value: unknown) => void = () => {};
  api.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await fireEvent.press(screen.getByText("Jamie"));
  api.mockResolvedValue({ ...page, items: [], teams: [] });
  await fireEvent.press(screen.getByText("Reset calendar filters"));
  await screen.findByText(
    "No published events match this date window and these filters.",
  );
  await act(async () => finish(page));
  expect(screen.queryByText("Sibling practice")).toBeNull();
});
test("loading, connection failure, empty and setup-required states stay distinct", async () => {
  api.mockRejectedValueOnce({ code: "functions/unavailable" });
  await render(<HouseholdAgenda refresh={0} />);
  await screen.findByText(
    "Unable to load your agenda. Check your connection and try again.",
  );
  api.mockResolvedValue({ ...page, items: [], setupRequired: true });
  await fireEvent.press(screen.getByText("Reload calendar"));
  await screen.findByText(
    "No published events match this date window and these filters.",
  );
  expect(screen.getByText(/Some legacy schedules need setup/)).toBeTruthy();
});
