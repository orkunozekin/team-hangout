import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import { AppState, Platform } from "react-native";
import ParticipantCheckIn from "../ParticipantCheckIn";
import {
  getParticipantCheckIn,
  checkInParticipant,
} from "../../firebase/checkIn";
import { currentCheckInLocation } from "../../lib/checkInLocation";
jest.mock("../../firebase/checkIn", () => ({
  getParticipantCheckIn: jest.fn(),
  checkInParticipant: jest.fn(),
}));
jest.mock("../../firebase/attendance", () => ({
  attendanceRequestId: jest.fn(() => "stable-id"),
}));
jest.mock("../../lib/checkInLocation", () => ({
  currentCheckInLocation: jest.fn(),
  isCheckInPermissionPending: jest.fn(() => false),
  canResumeCheckInPermission: jest.fn(() => true),
}));
const read = getParticipantCheckIn as jest.Mock,
  save = checkInParticipant as jest.Mock,
  locate = currentCheckInLocation as jest.Mock;
const data = {
  eventId: "e",
  participantId: "p",
  eventRevision: 3,
  scheduleVersion: 2,
  attendanceRevision: 0,
  status: "unknown",
  source: null,
  policy: {
    beforeMinutes: 40,
    afterMinutes: 120,
    radiusMeters: 500,
    locationEnabled: true,
  },
  locationEnabled: true,
  closedReason: null,
};
let change: (state: import("react-native").AppStateStatus) => void;
beforeEach(() => {
  jest.clearAllMocks();
  jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((_name, listener) => {
      change = listener;
      return { remove: jest.fn() };
    });
  read.mockResolvedValue(data);
  save.mockResolvedValue({ revision: 1 });
  locate.mockResolvedValue({
    latitude: 1,
    longitude: 2,
    accuracy: 10,
    timestamp: 100,
  });
});
async function open() {
  await render(
    <ParticipantCheckIn eventId="e" participantId="p" displayName="Jamie" />,
  );
  await fireEvent.press(screen.getByText("Check in Jamie"));
  await screen.findByText(/Actual attendance: unknown/);
}
test("requests no location on discovery or simple check-in, labels assertion and never implies absence", async () => {
  await open();
  expect(locate).not.toHaveBeenCalled();
  expect(screen.getByText(/spoofable/)).toBeTruthy();
  expect(screen.getByText(/Missing check-in stays unknown/)).toBeTruthy();
  read.mockResolvedValue({
    ...data,
    status: "present",
    source: "guardian",
    closedReason:
      "Attendance is already recorded. Ask your coach for corrections.",
  });
  await fireEvent.press(screen.getByText("Simple check-in for Jamie"));
  await screen.findByText(/Actual attendance: present/);
  expect(save).toHaveBeenCalledWith(
    {
      eventId: "e",
      participantId: "p",
      eventRevision: 3,
      scheduleVersion: 2,
      expectedRevision: 0,
      method: "simple",
      sample: null,
    },
    "stable-id",
  );
  expect(locate).not.toHaveBeenCalled();
  expect(screen.queryByText("Simple check-in for Jamie")).toBeNull();
});
test("permission denial and timeout leave simple/manual fallback without a write", async () => {
  await open();
  locate.mockRejectedValueOnce(
    new Error(
      "Location permission denied. Use simple check-in or ask your coach for manual attendance.",
    ),
  );
  await fireEvent.press(screen.getByText("Use location for Jamie"));
  await screen.findByText(/Location permission denied/);
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByText("Simple check-in for Jamie")).toBeTruthy();
  locate.mockRejectedValueOnce(
    new Error("Location timed out. Use simple check-in or ask your coach."),
  );
  await fireEvent.press(screen.getByText("Use location for Jamie"));
  await screen.findByText(/Location timed out/);
  expect(save).not.toHaveBeenCalled();
});
test.each([
  "Location sample is stale.",
  "Location accuracy is poor.",
  "Venue coordinates are unavailable.",
  "Outside the pilot check-in radius.",
  "Check-in is closed for this event.",
])("server fallback: %s", async (message) => {
  await open();
  save.mockRejectedValueOnce({
    code: "functions/failed-precondition",
    message,
  });
  await fireEvent.press(screen.getByText("Use location for Jamie"));
  await screen.findByText(message);
  expect(screen.getByText("Simple check-in for Jamie")).toBeTruthy();
});
test("unknown result retries exact sample and request, without reacquiring location", async () => {
  await open();
  save.mockRejectedValueOnce({ code: "functions/unavailable" });
  await fireEvent.press(screen.getByText("Use location for Jamie"));
  await screen.findByText(/Result unconfirmed/);
  const first = save.mock.calls[0];
  expect(screen.queryByText("Simple check-in for Jamie")).toBeNull();
  await fireEvent.press(screen.getByText("Retry same check-in for Jamie"));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
  expect(save.mock.calls[1]).toEqual(first);
  expect(locate).toHaveBeenCalledTimes(1);
});
test("background/unmount cancels delayed acquisition and foreground reload reauthorizes", async () => {
  let resolve!: (value: unknown) => void;
  locate.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await open();
  await fireEvent.press(screen.getByText("Use location for Jamie"));
  await act(() => change("background"));
  await act(() =>
    resolve({ latitude: 1, longitude: 2, accuracy: 10, timestamp: 100 }),
  );
  expect(save).not.toHaveBeenCalled();
  read.mockRejectedValueOnce({ code: "functions/permission-denied" });
  await act(() => change("active"));
  await screen.findByText(/Check-in access is unavailable/);
  expect(screen.queryByText("Simple check-in for Jamie")).toBeNull();
});
test("closed events and disabled location never expose disallowed acquisition controls", async () => {
  read.mockResolvedValueOnce({
    ...data,
    closedReason:
      "Outside the check-in window. Ask your coach for manual attendance.",
  });
  await open();
  expect(screen.queryByText("Simple check-in for Jamie")).toBeNull();
  expect(screen.queryByText("Use location for Jamie")).toBeNull();
  read.mockResolvedValueOnce({ ...data, locationEnabled: false });
  await fireEvent.press(screen.getByText("Reload check-in for Jamie"));
  await screen.findByText(/Location assistance is disabled/);
  expect(screen.queryByText("Use location for Jamie")).toBeNull();
});
test("stale schedule clears controls and requires reload", async () => {
  await open();
  save.mockRejectedValueOnce({ code: "functions/aborted" });
  await fireEvent.press(screen.getByText("Simple check-in for Jamie"));
  await screen.findByText(/Access or schedule changed/);
  expect(screen.queryByText("Simple check-in for Jamie")).toBeNull();
});

test("permission denial remains visible when the OS prompt returns active after acquisition settles", async () => {
  const marker = require("../../lib/checkInLocation")
    .isCheckInPermissionPending as jest.Mock;
  marker.mockReturnValue(true);
  let reject!: (value: unknown) => void;
  locate.mockImplementationOnce(
    () =>
      new Promise((_resolve, r) => {
        reject = r;
      }),
  );
  await open();
  await fireEvent.press(screen.getByText("Use location for Jamie"));
  await act(async () => change("inactive"));
  await act(async () =>
    reject(new Error("Location permission denied. Use simple check-in.")),
  );
  marker.mockReturnValue(false);
  await act(async () => change("active"));
  expect(
    screen.getByText("Location permission denied. Use simple check-in."),
  ).toBeTruthy();
  expect(read).toHaveBeenCalledTimes(1);
});

test("Android temporary permission Activity preserves the in-flight assertion across background/active", async () => {
  const platform = jest.replaceProperty(Platform, "OS", "android");
  const helper = require("../../lib/checkInLocation");
  helper.isCheckInPermissionPending.mockReturnValue(true);
  helper.canResumeCheckInPermission.mockReturnValue(true);
  let resolve!: (value: unknown) => void;
  locate.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  try {
    await open();
    await fireEvent.press(screen.getByText("Use location for Jamie"));
    await act(async () => change("background"));
    expect(screen.getByText(/Actual attendance: unknown/)).toBeTruthy();
    await act(async () => change("active"));
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () =>
      resolve({ latitude: 1, longitude: 2, accuracy: 10, timestamp: 100 }),
    );
    expect(save).toHaveBeenCalledTimes(1);
  } finally {
    helper.isCheckInPermissionPending.mockReturnValue(false);
    platform.restore();
  }
});
test("Android permission completion in a genuine background cancels and reauthorizes on return", async () => {
  const platform = jest.replaceProperty(Platform, "OS", "android");
  const helper = require("../../lib/checkInLocation");
  helper.isCheckInPermissionPending.mockReturnValue(true);
  helper.canResumeCheckInPermission.mockReturnValue(true);
  let reject!: (value: unknown) => void;
  locate.mockImplementationOnce(
    () =>
      new Promise((_r, r) => {
        reject = r;
      }),
  );
  try {
    await open();
    await fireEvent.press(screen.getByText("Use location for Jamie"));
    await act(async () => change("background"));
    await act(async () =>
      reject(
        new Error("Check-in interrupted. Try again while the app is open."),
      ),
    );
    helper.isCheckInPermissionPending.mockReturnValue(false);
    helper.canResumeCheckInPermission.mockReturnValue(false);
    read.mockRejectedValueOnce({ code: "functions/permission-denied" });
    await act(async () => change("active"));
    await screen.findByText(/Check-in access is unavailable/);
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByText(/Actual attendance/)).toBeNull();
  } finally {
    helper.canResumeCheckInPermission.mockReturnValue(true);
    platform.restore();
  }
});
