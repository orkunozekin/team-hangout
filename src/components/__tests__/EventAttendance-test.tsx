import React from "react";
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react-native";
import { AppState } from "react-native";
import EventAttendance from "../EventAttendance";
import {
  getEventAttendance,
  recordEventAttendance,
  getAttendanceHistory,
} from "../../firebase/attendance";
jest.mock("../../firebase/attendance", () => ({
  getEventAttendance: jest.fn(),
  recordEventAttendance: jest.fn(),
  getAttendanceHistory: jest.fn(),
  attendanceRequestId: () => "stable-id",
}));
const read = getEventAttendance as jest.Mock;
const save = recordEventAttendance as jest.Mock;
const audit = getAttendanceHistory as jest.Mock;
const item = {
  participantId: "child",
  displayName: "Jamie",
  eligible: true,
  rosterStatus: "active",
  canRecord: true,
  intended: "no",
  status: "unknown",
  revision: 0,
  previousStatus: null,
  recordedBy: null,
  recordedAt: null,
  source: null,
  correctionReason: null,
};
const data = {
  eventId: "event",
  teamId: "team",
  eventRevision: 3,
  scheduleVersion: 2,
  status: "scheduled",
  timeZone: "America/Chicago",
  snapshot: null,
  items: [item],
  nextCursor: null,
};
beforeEach(() => {
  jest.clearAllMocks();
  jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation(() => ({ remove: jest.fn() }));
  read.mockResolvedValue(data);
  save.mockResolvedValue({ revision: 1 });
  audit.mockResolvedValue({ items: [], nextCursor: null });
});
async function open() {
  await render(<EventAttendance eventId="event" teamId="team" />);
  await fireEvent.press(screen.getByText("Team attendance"));
  await screen.findByText("Jamie");
}
test("declined RSVP and unknown attendance remain independent; saves bind participant and schedule without device input", async () => {
  await open();
  expect(screen.getByText("Intended: No · Actual: Unknown")).toBeTruthy();
  await fireEvent.press(screen.getByLabelText("Present for Jamie"));
  await fireEvent.press(screen.getByText("Save attendance for Jamie"));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      {
        eventId: "event",
        teamId: "team",
        participantId: "child",
        expectedRevision: 0,
        eventRevision: 3,
        scheduleVersion: 2,
        status: "present",
        reason: null,
      },
      "stable-id",
    ),
  );
});
test("completion preserves unknown and requires a correction reason; audit displays actor, time and reason", async () => {
  read.mockResolvedValue({
    ...data,
    status: "completed",
    snapshot: { capturedRevision: 4 },
    items: [
      {
        ...item,
        revision: 1,
        status: "present",
        correctionReason: "Initial review",
      },
    ],
  });
  audit.mockResolvedValue({
    items: [
      {
        revision: 2,
        previousStatus: "present",
        status: "late",
        recordedBy: "coach",
        recordedAt: "2026-10-16T23:00:00.000Z",
        source: "coach",
        reason: "Arrived after warmup",
        scheduleVersion: 2,
      },
    ],
    nextCursor: null,
  });
  await open();
  await fireEvent.press(screen.getByLabelText("Late for Jamie"));
  await fireEvent.press(screen.getByText("Save attendance for Jamie"));
  expect(save).not.toHaveBeenCalled();
  await fireEvent.changeText(
    screen.getByLabelText("Correction reason for Jamie"),
    "Arrived after warmup",
  );
  await fireEvent.press(screen.getByText("Save attendance for Jamie"));
  await waitFor(() => expect(save).toHaveBeenCalled());
  await fireEvent.press(screen.getByText("Correction audit for Jamie"));
  expect(await screen.findByText(/Revision 2: Present → Late/)).toBeTruthy();
  expect(screen.getByText(/CDT · Schedule 2/)).toBeTruthy();
});
test("uncertain saves freeze controls and retry the same payload and request ID", async () => {
  save.mockRejectedValueOnce({ code: "functions/unavailable" });
  await open();
  await fireEvent.press(screen.getByLabelText("Present for Jamie"));
  await fireEvent.press(screen.getByText("Save attendance for Jamie"));
  await screen.findByText(/Result unconfirmed/);
  await fireEvent.press(screen.getByLabelText("Absent for Jamie"));
  await fireEvent.press(screen.getByText("Retry same attendance for Jamie"));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);
});
test("access loss clears roster and audit and offers reload; empty and cancelled states do not offer writes", async () => {
  read.mockResolvedValueOnce({
    ...data,
    status: "cancelled",
    items: [{ ...item, canRecord: false }],
  });
  await open();
  expect(screen.queryByText("Save attendance for Jamie")).toBeNull();
  read.mockRejectedValueOnce({ code: "functions/permission-denied" });
  await fireEvent.press(screen.getByText("Reload attendance"));
  await screen.findByText(/Attendance access changed/);
  expect(screen.queryByText("Jamie")).toBeNull();
  read.mockResolvedValueOnce({ ...data, items: [] });
  await fireEvent.press(screen.getByText("Reload attendance"));
  expect(
    await screen.findByText("No roster entries for this team."),
  ).toBeTruthy();
});
test("pagination retains rows and uses continuation; stale write clears controls", async () => {
  read
    .mockResolvedValueOnce({ ...data, nextCursor: "child" })
    .mockResolvedValueOnce({
      ...data,
      items: [
        {
          ...item,
          participantId: "child2",
          displayName: "Casey",
          intended: "unanswered",
        },
      ],
    });
  await open();
  await fireEvent.press(screen.getByText("Load more attendance"));
  await screen.findByText("Casey");
  expect(screen.getByText("Jamie")).toBeTruthy();
  expect(read).toHaveBeenLastCalledWith("event", "team", "child");
  save.mockRejectedValueOnce({
    code: "functions/aborted",
    message: "Reload changed attendance.",
  });
  await fireEvent.press(screen.getByText("Save attendance for Jamie"));
  await screen.findByText("Reload changed attendance.");
  expect(screen.queryByText("Casey")).toBeNull();
});
