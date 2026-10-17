import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import { AppState } from "react-native";
import EventAvailability from "../EventAvailability";
import {
  getEventAvailability,
  respondToEvent,
  setEventRsvpDeadline,
} from "../../firebase/availability";
jest.mock("../../firebase/availability", () => ({
  getEventAvailability: jest.fn(),
  respondToEvent: jest.fn(),
  setEventRsvpDeadline: jest.fn(),
  availabilityRequestId: jest.fn(() => "stable-id"),
}));
const api = getEventAvailability as jest.Mock;
const save = respondToEvent as jest.Mock;
const item = {
  participantId: "a",
  displayName: "Jamie",
  relationship: "guardian",
  teams: [{ id: "t", name: "Falcons" }],
  canRespond: true,
  closedReason: null,
  revision: 0,
  status: "unanswered",
  previousStatus: null,
  lateNote: null,
  actor: null,
};
const data = {
  eventId: "event",
  canManage: true,
  eventRevision: 4,
  scheduleVersion: 2,
  startsAt: "2026-11-01T06:30:00.000Z",
  endsAt: "2026-11-01T07:30:00.000Z",
  timeZone: "America/Chicago",
  deadline: "2026-11-01T06:30:00.000Z",
  items: [
    item,
    {
      ...item,
      participantId: "b",
      displayName: "Casey",
      revision: 1,
      status: "maybe",
      actor: "Another guardian",
    },
  ],
  summaries: [],
};
beforeEach(() => {
  jest.clearAllMocks();
  api.mockResolvedValue(data);
  save.mockResolvedValue({ revision: 1 });
});
test("two children have distinct unanswered/maybe controls and participant-bound note saves", async () => {
  await render(<EventAvailability eventId="event" />);
  await screen.findByText("Jamie");
  expect(
    screen.getByText("Maybe · Last response: Another guardian"),
  ).toBeTruthy();
  expect(screen.getByText("Unanswered")).toBeTruthy();
  expect(screen.getAllByText(/CDT/).length).toBeGreaterThan(0);
  await fireEvent.press(screen.getByRole("button", { name: "Yes for Jamie" }));
  await fireEvent.changeText(
    screen.getByLabelText("Late-arrival note for Jamie"),
    "Ten minutes late",
  );
  await fireEvent.press(screen.getByText("Save response for Jamie"));
  expect(save).toHaveBeenCalledWith(
    {
      eventId: "event",
      participantId: "a",
      expectedRevision: 0,
      scheduleVersion: 2,
      status: "yes",
      lateNote: "Ten minutes late",
    },
    "stable-id",
  );
});
test("reconfirmation requires explicit choice and retains historical actor/note context", async () => {
  api.mockResolvedValue({
    ...data,
    items: [
      {
        ...item,
        revision: 1,
        status: "needsReconfirmation",
        previousStatus: "yes",
        lateNote: "School pickup",
        actor: "You",
      },
    ],
  });
  await render(<EventAvailability eventId="event" />);
  await screen.findByText("Needs reconfirmation · Last response: You");
  expect(screen.getByText(/Previous response: Yes/)).toBeTruthy();
  expect(screen.getByText("Reconfirm Jamie")).toBeDisabled();
  await fireEvent.press(
    screen.getByRole("button", { name: "Maybe for Jamie" }),
  );
  await fireEvent.press(screen.getByText("Reconfirm Jamie"));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      expectedRevision: 1,
      scheduleVersion: 2,
      status: "maybe",
    }),
    "stable-id",
  );
});
test("uncertain saves freeze payload and retry the same request, then reauthorize by reload", async () => {
  save.mockRejectedValueOnce({ code: "functions/unavailable" });
  await render(<EventAvailability eventId="event" />);
  await screen.findByText("Jamie");
  await fireEvent.press(screen.getByRole("button", { name: "No for Jamie" }));
  await fireEvent.press(screen.getByText("Save response for Jamie"));
  await screen.findByText("Retry same response for Jamie");
  expect(screen.getByRole("button", { name: "Yes for Jamie" })).toBeDisabled();
  await fireEvent.press(screen.getByText("Retry same response for Jamie"));
  expect(save.mock.calls[0]).toEqual(save.mock.calls[1]);
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
});
test("stale saves clear old controls and force a live reload before editing", async () => {
  save.mockRejectedValueOnce({
    code: "functions/aborted",
    details: { domainCode: "STALE_REVISION" },
  });
  await render(<EventAvailability eventId="event" />);
  await screen.findByText("Jamie");
  await fireEvent.press(screen.getByRole("button", { name: "Yes for Jamie" }));
  await fireEvent.press(screen.getByText("Save response for Jamie"));
  await screen.findByText(/Another guardian or the schedule changed/);
  expect(screen.queryByText("Jamie")).toBeNull();
  api.mockResolvedValue({
    ...data,
    items: [{ ...item, revision: 2, status: "no", actor: "Another guardian" }],
  });
  await fireEvent.press(screen.getByText("Reload responses"));
  await screen.findByText("No · Last response: Another guardian");
});
test("closed/view-only responses display policy and do not allow editing", async () => {
  api.mockResolvedValue({
    ...data,
    items: [
      {
        ...item,
        canRespond: false,
        closedReason: "The RSVP deadline has passed. Responses are closed.",
      },
    ],
  });
  await render(<EventAvailability eventId="event" />);
  await screen.findByText(/deadline has passed/);
  expect(screen.getByRole("button", { name: "Yes for Jamie" })).toBeDisabled();
  expect(screen.queryByText("Save response for Jamie")).toBeNull();
});
test("late responses from old events and background refresh cannot restore revoked data", async () => {
  let finish: (value: unknown) => void = () => {};
  api.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const view = await render(<EventAvailability eventId="old" />);
  api.mockRejectedValue({ code: "functions/permission-denied" });
  await view.rerender(<EventAvailability eventId="new" />);
  await screen.findByText(/Access changed/);
  await act(async () => finish(data));
  expect(screen.queryByText("Jamie")).toBeNull();
});
test("staff totals are separate and deadline controls use exact displayed event instants", async () => {
  api.mockResolvedValue({
    ...data,
    items: [],
    summaries: [
      {
        teamId: "a",
        teamName: "Falcons",
        counts: {
          yes: 1,
          no: 0,
          maybe: 2,
          unanswered: 3,
          needsReconfirmation: 1,
        },
      },
    ],
  });
  await render(<EventAvailability eventId="event" canManage />);
  await screen.findByText("Falcons responses");
  expect(screen.getByText("Needs reconfirmation: 1")).toBeTruthy();
  await fireEvent.press(screen.getByText("Close 1 hour before start"));
  expect(setEventRsvpDeadline).toHaveBeenCalledWith(
    "event",
    4,
    "2026-11-01T05:30:00.000Z",
  );
});
test("foreground refresh removes stale controls and reloads current access", async () => {
  let change: (state: import("react-native").AppStateStatus) => void = () => {};
  const listener = jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((_type, cb) => {
      change = cb;
      return { remove: jest.fn() };
    });
  const view = await render(<EventAvailability eventId="event" />);
  await screen.findByText("Jamie");
  await act(async () => change("background"));
  expect(screen.queryByText("Jamie")).toBeNull();
  api.mockResolvedValue({ ...data, items: [], summaries: [] });
  await act(async () => change("active"));
  await waitFor(() => expect(api).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("Jamie")).toBeNull();
  await view.unmount();
  listener.mockRestore();
});

test("revoked management with remaining household access hides deadline controls", async () => {
  api.mockResolvedValue({ ...data, canManage: false });
  await render(<EventAvailability eventId="event" canManage />);
  await screen.findByText("Jamie");
  expect(screen.queryByText("Close 1 hour before start")).toBeNull();
});
