import React from "react";
import { render, screen, fireEvent } from "@testing-library/react-native";
import InvitationScreen from "../InvitationScreen";
import { httpsCallable } from "firebase/functions";
import { auth } from "../../firebase/config";
jest.mock("../../firebase/config", () => ({
  auth: { currentUser: { uid: "parent" } },
  functions: {},
}));
jest.mock("firebase/functions", () => ({ httpsCallable: jest.fn() }));
jest.mock("firebase/auth", () => ({ sendEmailVerification: jest.fn() }));
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
const user = {
  uid: "parent",
  email: "parent@example.test",
  getIdToken: jest.fn().mockResolvedValue("demo"),
} as any;
let status = "pending";
let calls: string[];
beforeEach(() => {
  calls = [];
  status = "pending";
  (auth as any).currentUser = user;
  (httpsCallable as jest.Mock).mockImplementation((_f, name) => async () => {
    calls.push(name);
    return {
      data:
        name === "acceptInvitation"
          ? { status: "accepted" }
          : {
              status,
              participantName: "Jamie",
              relationship: "guardian",
              permissions: { viewProfile: true, viewSchedule: true },
            },
    };
  });
});
test("pending invitation waits for explicit confirmation and shows acceptance result", async () => {
  await render(
    <InvitationScreen user={user} token={"a".repeat(43)} onClose={jest.fn()} />,
  );
  await screen.findByText("Jamie");
  expect(calls).toEqual(["inspectInvitation"]);
  await fireEvent.press(screen.getByText("Confirm and accept invitation"));
  await screen.findByText(
    "Invitation accepted. Open your household to check current access.",
  );
  expect(calls).toEqual(["inspectInvitation", "acceptInvitation"]);
});
test("wrong-account recovery does not offer acceptance and close discards pending navigation", async () => {
  status = "wrong-email";
  const close = jest.fn();
  await render(
    <InvitationScreen user={user} token={"a".repeat(43)} onClose={close} />,
  );
  await screen.findByText(/This invitation is for another email address/);
  expect(screen.queryByText("Confirm and accept invitation")).toBeNull();
  await fireEvent.press(screen.getByText("Close invitation"));
  expect(close).toHaveBeenCalledTimes(1);
  expect(calls).toEqual(["inspectInvitation"]);
});
