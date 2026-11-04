import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import CheckInPolicyEditor from "../CheckInPolicyEditor";
import { setEventCheckInPolicy } from "../../firebase/checkIn";
jest.mock("../../firebase/checkIn", () => ({
  setEventCheckInPolicy: jest.fn(),
}));
const policy = {
  beforeMinutes: 40,
  afterMinutes: 120,
  radiusMeters: 500,
  locationEnabled: true,
};
test("staff edit labeled minutes/radius and explicit event assistance setting", async () => {
  const done = jest.fn();
  await render(
    <CheckInPolicyEditor
      eventId="e"
      eventRevision={3}
      policy={policy}
      onSaved={done}
    />,
  );
  await fireEvent.changeText(
    screen.getByLabelText("Check-in minutes before start"),
    "30",
  );
  await fireEvent.changeText(
    screen.getByLabelText("Check-in radius meters"),
    "250",
  );
  await fireEvent.press(screen.getByText("Disable event location assistance"));
  await fireEvent.press(screen.getByText("Save check-in settings"));
  expect(setEventCheckInPolicy).toHaveBeenCalledWith("e", 3, {
    ...policy,
    beforeMinutes: 30,
    radiusMeters: 250,
    locationEnabled: false,
  });
  expect(done).toHaveBeenCalled();
});
test("bad numbers never submit; unconfirmed policy save requires reconciliation", async () => {
  (setEventCheckInPolicy as jest.Mock).mockClear();
  await render(
    <CheckInPolicyEditor
      eventId="e"
      eventRevision={3}
      policy={policy}
      onSaved={jest.fn()}
    />,
  );
  await fireEvent.changeText(
    screen.getByLabelText("Check-in radius meters"),
    "2e3",
  );
  await fireEvent.press(screen.getByText("Save check-in settings"));
  await screen.findByText("Enter whole minutes and meters.");
  expect(setEventCheckInPolicy).not.toHaveBeenCalled();
  await fireEvent.changeText(
    screen.getByLabelText("Check-in radius meters"),
    "250",
  );
  (setEventCheckInPolicy as jest.Mock).mockRejectedValueOnce({
    code: "functions/unavailable",
  });
  await fireEvent.press(screen.getByText("Save check-in settings"));
  await screen.findByText(/Policy save was not confirmed/);
});
