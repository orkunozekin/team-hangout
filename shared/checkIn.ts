export type CheckInPolicy = {
  beforeMinutes: number;
  afterMinutes: number;
  radiusMeters: number;
  locationEnabled: boolean;
};
export type LocationSample = {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
};
export type ParticipantCheckIn = {
  eventId: string;
  participantId: string;
  eventRevision: number;
  scheduleVersion: number;
  attendanceRevision: number;
  status: string;
  source: string | null;
  policy: CheckInPolicy;
  locationEnabled: boolean;
  closedReason: string | null;
};
