import { AppState } from "react-native";
import * as Location from "expo-location";
import { currentCheckInLocation } from "../checkInLocation";
jest.mock("expo-location", () => ({
  requestForegroundPermissionsAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  Accuracy: { High: 4 },
}));
const permission = Location.requestForegroundPermissionsAsync as jest.Mock,
  position = Location.getCurrentPositionAsync as jest.Mock;
beforeEach(() => {
  jest.clearAllMocks();
  permission.mockResolvedValue({ status: "granted" });
  position.mockResolvedValue({
    coords: { latitude: 1, longitude: 2, accuracy: 10 },
    timestamp: 3,
  });
});
afterEach(() => jest.useRealTimers());
test("one foreground request returns only transient sample fields", async () => {
  expect(await currentCheckInLocation()).toEqual({
    latitude: 1,
    longitude: 2,
    accuracy: 10,
    timestamp: 3,
  });
  expect(permission).toHaveBeenCalledTimes(1);
  expect(position).toHaveBeenCalledWith({ accuracy: 4 });
});
test("denied permission makes no sample request", async () => {
  permission.mockResolvedValue({ status: "denied" });
  await expect(currentCheckInLocation()).rejects.toThrow("permission denied");
  expect(position).not.toHaveBeenCalled();
});
test("missing accuracy fails closed as zero for the server", async () => {
  position.mockResolvedValue({
    coords: { latitude: 1, longitude: 2, accuracy: null },
    timestamp: 3,
  });
  expect((await currentCheckInLocation()).accuracy).toBe(0);
});
test("timeout bounds stalled positioning", async () => {
  jest.useFakeTimers();
  position.mockImplementation(() => new Promise(() => {}));
  const result = currentCheckInLocation();
  const rejection = expect(result).rejects.toThrow("timed out");
  await jest.advanceTimersByTimeAsync(15000);
  await rejection;
});
test("late permission after timeout does not begin positioning", async () => {
  jest.useFakeTimers();
  let resolve!: (value: unknown) => void;
  permission.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const result = currentCheckInLocation();
  const rejection = expect(result).rejects.toThrow("timed out");
  await jest.advanceTimersByTimeAsync(15000);
  await rejection;
  resolve({ status: "granted" });
  await Promise.resolve();
  expect(position).not.toHaveBeenCalled();
});
test("obsolete request and background never begin positioning", async () => {
  await expect(currentCheckInLocation(() => false)).rejects.toThrow(
    "interrupted",
  );
  expect(position).not.toHaveBeenCalled();
  const original = AppState.currentState;
  AppState.currentState = "background";
  try {
    await expect(currentCheckInLocation()).rejects.toThrow("interrupted");
  } finally {
    AppState.currentState = original;
  }
});
