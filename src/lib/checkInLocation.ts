import { AppState } from "react-native";
import * as Location from "expo-location";
import type { LocationSample } from "../../shared/checkIn";
let pendingPermissions = 0;
let permissionReturnedInBackground = false;
export const isCheckInPermissionPending = () => pendingPermissions > 0;
export const canResumeCheckInPermission = () =>
  pendingPermissions > 0 || !permissionReturnedInBackground;
export async function currentCheckInLocation(
  isCurrent: () => boolean = () => true,
): Promise<LocationSample> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        pendingPermissions++;
        permissionReturnedInBackground = false;
        let permission: Location.LocationPermissionResponse;
        try {
          permission = await Location.requestForegroundPermissionsAsync();
        } finally {
          permissionReturnedInBackground =
            AppState.currentState === "background";
          pendingPermissions--;
        }
        if (permission.status !== "granted")
          throw new Error(
            "Location permission denied. Use simple check-in or ask your coach for manual attendance.",
          );
        if (stopped || !isCurrent() || AppState.currentState === "background")
          throw new Error(
            "Check-in interrupted. Try again while the app is open.",
          );
        const sample = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });
        return {
          latitude: sample.coords.latitude,
          longitude: sample.coords.longitude,
          accuracy: sample.coords.accuracy ?? 0,
          timestamp: sample.timestamp,
        };
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          stopped = true;
          reject(
            new Error(
              "Location timed out. Use simple check-in or ask your coach for manual attendance.",
            ),
          );
        }, 15000);
      }),
    ]);
  } finally {
    stopped = true;
    clearTimeout(timer);
  }
}
