import React from "react";
import { Alert } from "react-native";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { httpsCallable } from "firebase/functions";
import CalendarSubscriptionsScreen from "../CalendarSubscriptionsScreen";
jest.mock("../../firebase/config", () => ({ db: {}, functions: {} }));
jest.mock("firebase/functions", () => ({ httpsCallable: jest.fn() }));
jest.mock("firebase/firestore", () => ({
  collection: jest.fn(),
  doc: () => ({ id: "fixed-action" }),
}));
const team = {
  id: "team",
  orgId: "org",
  name: "Stars",
  organizationName: "Demo Club",
  participants: [
    { orgId: "org", participantId: "jamie", displayName: "Jamie" },
  ],
};
let calls: { name: string; data: any }[],
  failed = false;
beforeEach(() => {
  calls = [];
  failed = false;
  jest.clearAllMocks();
  jest.spyOn(Alert, "alert").mockImplementation((_title, _copy, buttons) => {
    buttons?.[buttons.length - 1].onPress?.();
  });
  (httpsCallable as jest.Mock).mockImplementation(
    (_f, name) => async (data: any) => {
      calls.push({ name, data });
      if (name === "calendarSubscriptionOptions")
        return { data: { teams: [team] } };
      if (name === "listCalendarSubscriptions") return { data: { items: [] } };
      if (failed) {
        failed = false;
        throw { code: "functions/unavailable" };
      }
      return {
        data: {
          subscription: { id: "sub", revision: 1 },
          url: "https://calendar.example.test/?token=private",
        },
      };
    },
  );
});
test("minimal selection and default name privacy require explicit confirmation", async () => {
  await render(<CalendarSubscriptionsScreen onBack={() => {}} />);
  await screen.findByText("Stars · Demo Club");
  expect(
    screen.getByRole("button", { name: "Create private URL" }).props
      .accessibilityState.disabled,
  ).toBe(true);
  await fireEvent.press(
    screen.getByRole("checkbox", { name: "Stars · Demo Club" }),
  );
  await fireEvent.press(
    screen.getByRole("button", { name: "Create private URL" }),
  );
  await screen.findByText("Your private URL");
  const issue = calls.find((c) => c.name === "createCalendarSubscription")!;
  expect(issue.data).toEqual({
    requestId: "fixed-action",
    teamIds: ["team"],
    participantRefs: [],
    eventTypes: ["practice", "match"],
    includeParticipantNames: false,
  });
  expect(Alert.alert).toHaveBeenCalled();
  await fireEvent.press(
    screen.getByRole("button", { name: "Reload subscriptions" }),
  );
  expect(
    screen.queryByText("https://calendar.example.test/?token=private"),
  ).toBeNull();
});
test("uncertain issue retains identical action and does not issue another scope on retry", async () => {
  await render(<CalendarSubscriptionsScreen onBack={() => {}} />);
  await screen.findByText("Stars · Demo Club");
  await fireEvent.press(
    screen.getByRole("checkbox", { name: "Stars · Demo Club" }),
  );
  failed = true;
  await fireEvent.press(
    screen.getByRole("button", { name: "Create private URL" }),
  );
  await screen.findByText(
    "The result is uncertain. Retry the same action before making another change.",
  );
  expect(
    screen.getByRole("checkbox", { name: "Stars · Demo Club" }).props
      .accessibilityState.disabled,
  ).toBe(true);
  await fireEvent.press(
    screen.getByRole("button", { name: "Retry same action" }),
  );
  await screen.findByText("Your private URL");
  const issues = calls.filter((c) => c.name === "createCalendarSubscription");
  expect(issues).toHaveLength(2);
  expect(issues[1].data).toEqual(issues[0].data);
});
test("late issue response is discarded after leaving management", async () => {
  let resolve: (value: any) => void = () => {};
  const normal = (httpsCallable as jest.Mock).getMockImplementation()!;
  (httpsCallable as jest.Mock).mockImplementation((f, name) =>
    name === "createCalendarSubscription"
      ? () =>
          new Promise((r) => {
            resolve = r;
          })
      : normal(f, name),
  );
  const view = await render(<CalendarSubscriptionsScreen onBack={() => {}} />);
  await screen.findByText("Stars · Demo Club");
  await fireEvent.press(
    screen.getByRole("checkbox", { name: "Stars · Demo Club" }),
  );
  await fireEvent.press(
    screen.getByRole("button", { name: "Create private URL" }),
  );
  await view.unmount();
  await act(() => {
    resolve({ data: { url: "private-late", subscription: { id: "sub" } } });
  });
  expect(screen.queryByText("private-late")).toBeNull();
});

test("saved subscriptions remain removable while discovery is pending or failed", async () => {
  let rejectOptions: (error: Error) => void = () => {};
  let removed = false;
  const saved = {
    id: "saved",
    revision: 1,
    scope: {
      teamIds: ["team"],
      participantRefs: [],
      eventTypes: ["practice"],
      includeParticipantNames: false,
    },
  };
  (httpsCallable as jest.Mock).mockImplementation(
    (_f, name) => async (data: any) => {
      calls.push({ name, data });
      if (name === "calendarSubscriptionOptions")
        return new Promise((_resolve, reject) => {
          rejectOptions = reject;
        });
      if (name === "listCalendarSubscriptions")
        return { data: { items: removed ? [] : [saved] } };
      if (name === "revokeCalendarSubscription") {
        removed = true;
        return { data: { ok: true } };
      }
      throw new Error("Unexpected command");
    },
  );
  await render(<CalendarSubscriptionsScreen onBack={() => {}} />);
  const remove = await screen.findByRole("button", {
    name: "Remove subscription",
  });
  expect(remove.props.accessibilityState.disabled).toBe(false);
  await act(() => {
    rejectOptions(new Error("Discovery limit"));
  });
  await screen.findByText(
    "Unable to load team choices. Saved subscriptions can still be removed.",
  );
  await fireEvent.press(
    screen.getByRole("button", { name: "Remove subscription" }),
  );
  await screen.findByText("No active subscriptions.");
  expect(
    calls.find((c) => c.name === "revokeCalendarSubscription")?.data
      .subscriptionId,
  ).toBe("saved");
});
