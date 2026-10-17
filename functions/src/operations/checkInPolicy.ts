type CheckInPolicy = {
  beforeMinutes: number;
  afterMinutes: number;
  radiusMeters: number;
  locationEnabled: boolean;
};
type LocationSample = {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
};
export const checkInPolicy = (
  value?: Partial<CheckInPolicy>,
): CheckInPolicy => ({
  beforeMinutes: 40,
  afterMinutes: 120,
  radiusMeters: 500,
  locationEnabled: true,
  ...value,
});
export function locationOutcome(
  sample: LocationSample,
  venue: { latitude?: number | null; longitude?: number | null } | undefined,
  now: number,
  radius: number,
): string | null {
  if (
    ![
      sample.latitude,
      sample.longitude,
      sample.accuracy,
      sample.timestamp,
    ].every(Number.isFinite) ||
    Math.abs(sample.latitude) > 90 ||
    Math.abs(sample.longitude) > 180 ||
    sample.accuracy <= 0
  )
    return "Invalid location sample. Use simple check-in or ask your coach.";
  if (sample.timestamp > now || now - sample.timestamp > 60000)
    return "Location sample is stale. Try again or use simple check-in.";
  if (sample.accuracy > 100)
    return "Location accuracy is poor. Try outdoors or use simple check-in.";
  if (
    typeof venue?.latitude !== "number" ||
    typeof venue?.longitude !== "number" ||
    !Number.isFinite(venue.latitude) ||
    !Number.isFinite(venue.longitude) ||
    Math.abs(venue.latitude) > 90 ||
    Math.abs(venue.longitude) > 180
  )
    return "Venue coordinates are unavailable. Use simple check-in or ask your coach.";
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const a =
    Math.sin(radians(sample.latitude - venue.latitude) / 2) ** 2 +
    Math.cos(radians(venue.latitude)) *
      Math.cos(radians(sample.latitude)) *
      Math.sin(radians(sample.longitude - venue.longitude) / 2) ** 2;
  const distance = 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
  return distance > radius
    ? "Outside the pilot check-in radius. Use simple check-in or ask your coach."
    : null;
}
