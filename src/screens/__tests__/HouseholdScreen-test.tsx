import React from "react";
import { Alert, AppState, Platform, type AppStateStatus } from "react-native";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import HouseholdScreen from "../HouseholdScreen";
import { httpsCallable } from "firebase/functions";
import { runCommand } from "../../firebase/commands";
let mockAgendaRefreshed: (() => void) | undefined;
let mockAgendaDenied: (() => void) | undefined;
jest.mock(
  "../../components/HouseholdAgenda",
  () =>
    ({
      onAccessDenied,
      onAccessRefreshed,
    }: {
      onAccessDenied: () => void;
      onAccessRefreshed: () => void;
    }) => {
      mockAgendaDenied = onAccessDenied;
      mockAgendaRefreshed = onAccessRefreshed;
      return null;
    },
);
let mockBlur: (() => void) | undefined;
jest.mock("@react-navigation/native", () => ({
  useFocusEffect: (effect: () => () => void) =>
    require("react").useEffect(() => {
      const cleanup = effect();
      mockBlur = cleanup;
      return cleanup;
    }, []),
}));
jest.mock("../../firebase/config", () => ({ db: {}, functions: {} }));
jest.mock("firebase/functions", () => ({ httpsCallable: jest.fn() }));
jest.mock("firebase/firestore", () => ({
  collection: jest.fn(),
  doc: () => ({ id: "retry-action" }),
}));
jest.mock("../../firebase/commands", () => ({ runCommand: jest.fn() }));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
const user = { uid: "parent", email: "parent@example.test" } as any;
const children = [
  { id: "a", orgId: "org", displayName: "Jamie", relationship: "guardian" },
  { id: "b", orgId: "org", displayName: "Casey", relationship: "guardian" },
];
let revoked = false;
beforeEach(() => {
  jest.clearAllMocks();
  revoked = false;
  jest
    .spyOn(AppState, "addEventListener")
    .mockReturnValue({ remove: jest.fn() });
  (httpsCallable as jest.Mock).mockImplementation(
    (_functions, name) => async (input: any) => {
      if (name === "listMyParticipants")
        return {
          data: { items: revoked ? [children[1]] : children, nextCursor: null },
        };
      if (revoked && input.participantId === "a")
        throw { code: "functions/permission-denied" };
      return {
        data: {
          participant: children.find((c) => c.id === input.participantId),
          profile: { revision: 4, contactPhone: "555-0100" },
          guardians: [{ displayName: "Alex", isYou: true }],
          relationship: "guardian",
          canEdit: input.participantId === "a",
        },
      };
    },
  );
});
test("two children keep identity, acting label and edit permission when switching to Teams and profiles", async () => {
  const teams = jest.fn(), inbox = jest.fn();
  await render(<HouseholdScreen user={user} onTeams={teams} onInbox={inbox} />);
  await screen.findByText("Jamie");
  await fireEvent.press(screen.getByLabelText("View Jamie, guardian access"));
  await screen.findByText("Acting as parent@example.test for Jamie");
  expect(screen.getByText("Alex (you)")).toBeTruthy();
  expect(screen.getByText("Review and save contact details")).toBeTruthy();
  await fireEvent.press(screen.getByText("Back to participants"));
  await screen.findByText("Casey");
  await fireEvent.press(screen.getByLabelText("View Casey, guardian access"));
  await screen.findByText("Acting as parent@example.test for Casey");
  expect(screen.queryByText("Review and save contact details")).toBeNull();
  await fireEvent.press(screen.getByText("Open Teams"));
  expect(teams).toHaveBeenCalledTimes(1);
  await fireEvent.press(screen.getByText("Open Inbox"));
  expect(inbox).toHaveBeenCalledTimes(1);
});
test("onboarding household opens conversations and hides calendar subscriptions when the sidebar owns them", async () => {
  const conversations = jest.fn();
  await render(<HouseholdScreen user={user} onTeams={jest.fn()} onConversations={conversations} showCalendarSubscriptions={false} />);
  await fireEvent.press(screen.getByText("Open Conversations"));
  expect(conversations).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Calendar subscriptions")).toBeNull();
});
test("save confirms account and participant, passes loaded revision and removes profile after revocation", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  (runCommand as jest.Mock).mockRejectedValue({
    code: "functions/permission-denied",
  });
  await render(<HouseholdScreen user={user} onTeams={jest.fn()} />);
  await screen.findByText("Jamie");
  await fireEvent.press(screen.getByLabelText("View Jamie, guardian access"));
  await screen.findByText("Review and save contact details");
  await fireEvent.changeText(
    screen.getByLabelText("Participant phone"),
    "555-0200",
  );
  await fireEvent.press(screen.getByText("Review and save contact details"));
  expect(alert.mock.calls[0][1]).toContain(
    "parent@example.test is acting for Jamie",
  );
  revoked = true;
  await act(async () => {
    (alert.mock.calls[0][2]![1]!.onPress as () => void)();
  });
  await waitFor(() =>
    expect(runCommand).toHaveBeenCalledWith(
      "editParticipantProfile",
      expect.objectContaining({
        participantId: "a",
        expectedRevision: 4,
        fields: { contactEmail: null, contactPhone: "555-0200" },
      }),
      "retry-action",
    ),
  );
  await screen.findByText(
    "Permission removed or profile unavailable. Your household has been refreshed.",
  );
  expect(screen.queryByLabelText("Participant phone")).toBeNull();
  await screen.findByText("Casey");
  expect(screen.queryByText("Jamie")).toBeNull();
  alert.mockRestore();
});

test("foregrounding while on Teams does not reload the hidden household", async () => {
  let change: ((state: AppStateStatus) => void) | undefined;
  const listener = jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((_event, handler) => {
      change = handler;
      return { remove: jest.fn() };
    });
  await render(<HouseholdScreen user={user} onTeams={jest.fn()} />);
  await screen.findByText("Jamie");
  await act(async () => {
    mockBlur?.();
  });
  const before = (httpsCallable as jest.Mock).mock.calls.length;
  await act(async () => {
    change?.("background");
    change?.("active");
  });
  expect((httpsCallable as jest.Mock).mock.calls.length).toBe(before);
  expect(screen.queryByText("Jamie")).toBeNull();
  listener.mockRestore();
});

test("agenda authorization loss also clears previously loaded participant labels", async () => {
  await render(<HouseholdScreen user={user} onTeams={jest.fn()} />);
  await screen.findByText("Jamie");
  await act(async () => mockAgendaDenied?.());
  await screen.findByText(
    "Household access changed. Reload your household to confirm current permissions.",
  );
  expect(screen.queryByText("Jamie")).toBeNull();
  expect(screen.queryByText("Casey")).toBeNull();
});

test("delayed participant discovery cannot repopulate household after agenda denial", async () => {
  let finish: (value: unknown) => void = () => {};
  (httpsCallable as jest.Mock).mockImplementation(
    () => () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await render(<HouseholdScreen user={user} onTeams={jest.fn()} />);
  await act(async () => mockAgendaDenied?.());
  await act(async () =>
    finish({ data: { items: children, nextCursor: null } }),
  );
  expect(screen.queryByText("Jamie")).toBeNull();
  expect(screen.queryByText("Casey")).toBeNull();
});

test("successful calendar refresh reauthorizes participant discovery after an individual grant is revoked", async () => {
  await render(<HouseholdScreen user={user} onTeams={jest.fn()} />);
  await screen.findByText("Jamie");
  revoked = true;
  await act(async () => mockAgendaRefreshed?.());
  await screen.findByText("Casey");
  expect(screen.queryByText("Jamie")).toBeNull();
  expect(screen.queryByLabelText("View Jamie, guardian access")).toBeNull();
});

test("the explicit location permission prompt preserves household state while a real background clears it", async () => {
  const location = require("../../lib/checkInLocation");
  const marker = jest
    .spyOn(location, "isCheckInPermissionPending")
    .mockReturnValue(true);
  let change: ((state: AppStateStatus) => void) | undefined;
  jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((_event, handler) => {
      change = handler;
      return { remove: jest.fn() };
    });
  await render(<HouseholdScreen user={user} onTeams={jest.fn()} />);
  await screen.findByText("Jamie");
  const before = (httpsCallable as jest.Mock).mock.calls.length;
  await act(async () => change?.("inactive"));
  expect(screen.getByText("Jamie")).toBeTruthy();
  marker.mockReturnValue(false);
  await act(async () => change?.("active"));
  expect((httpsCallable as jest.Mock).mock.calls.length).toBe(before);
  await act(async () => change?.("background"));
  expect(screen.queryByText("Jamie")).toBeNull();
  marker.mockRestore();
});

test("Android permission Activity retains the household but reauthorizes if the permission result stayed backgrounded", async () => {
  const platform = jest.replaceProperty(Platform, "OS", "android"),
    helper = require("../../lib/checkInLocation");
  const marker = jest
      .spyOn(helper, "isCheckInPermissionPending")
      .mockReturnValue(true),
    resume = jest
      .spyOn(helper, "canResumeCheckInPermission")
      .mockReturnValue(true);
  let change: ((state: AppStateStatus) => void) | undefined;
  jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation((_event, handler) => {
      change = handler;
      return { remove: jest.fn() };
    });
  try {
    await render(<HouseholdScreen user={user} onTeams={jest.fn()} />);
    await screen.findByText("Jamie");
    const before = (httpsCallable as jest.Mock).mock.calls.length;
    await act(async () => change?.("background"));
    expect(screen.getByText("Jamie")).toBeTruthy();
    await act(async () => change?.("active"));
    expect((httpsCallable as jest.Mock).mock.calls.length).toBe(before);
    await act(async () => change?.("background"));
    marker.mockReturnValue(false);
    resume.mockReturnValue(false);
    await act(async () => change?.("active"));
    await waitFor(() =>
      expect((httpsCallable as jest.Mock).mock.calls.length).toBeGreaterThan(
        before,
      ),
    );
  } finally {
    marker.mockRestore();
    resume.mockRestore();
    platform.restore();
  }
});
