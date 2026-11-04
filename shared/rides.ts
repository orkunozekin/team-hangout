/** Wire contracts for Phase 3 ride coordination. Keep aligned with functions/src/volunteers/rides.ts. */
export const RIDE_DIRECTIONS = ["toEvent", "fromEvent"] as const;
export type RideDirection = (typeof RIDE_DIRECTIONS)[number];
export type RideKind = "need" | "offer";

export const RIDE_DIRECTION_LABELS: Record<RideDirection, string> = { toEvent: "To the event", fromEvent: "Home from the event" };
export const RIDE_SEATS_MAX = 8;
export const RIDE_CHILDREN_MAX = 4;
export const RIDE_CONTACT_MAX = 120;
export const RIDE_PICKUP_MAX = 200;

/** The caller's own offer, or a request for at least one of the caller's linked children. */
export type OwnRide = {
  rideId: string;
  kind: RideKind;
  direction: RideDirection;
  area: string;
  seats: number;
  seatsOpen: number | null;
  discoverable: boolean;
  status: "open" | "cancelled";
  revision: number;
  /** Only the caller's own linked children are named. */
  participants: { participantId: string; displayName: string }[];
  canEdit: boolean;
  updatedByYou: boolean;
  /** A pending or confirmed arrangement uses this ride. */
  hasArrangement: boolean;
};

/** Opt-in discovery row: no names, children, owners or contacts. */
export type RideMatch = { rideId: string; kind: RideKind; direction: RideDirection; area: string; seats: number; revision: number };

export type RideArrangementState = "pending" | "confirmed" | "cancelled";

export type RideArrangement = {
  arrangementId: string;
  role: "driver" | "rider";
  state: RideArrangementState;
  direction: RideDirection;
  seats: number;
  revision: number;
  counterpartAlias: string | null;
  yourAlias: string | null;
  awaitingYou: boolean;
  participants: string[];
};

export type RideCoordination = {
  openRequests: number;
  openSeats: number;
  arrangements: { arrangementId: string; state: RideArrangementState; direction: RideDirection; seats: number; driverAlias: string | null; riderAlias: string | null }[];
};

type RideBase = { orgId: string; eventId: string; teamId: string; eventStatus: string };
export type EventRides =
  | (RideBase & { enabled: false })
  | (RideBase & {
      enabled: true;
      policyVersion: string;
      consentVersion: string;
      canOffer: boolean;
      children: { participantId: string; displayName: string }[];
      mine: OwnRide[];
      matches: RideMatch[];
      arrangements: RideArrangement[];
      coordination: RideCoordination | null;
    });

export type RideContact = { arrangementId: string; counterpart: { role: "driver" | "rider"; alias: string; contact: string; pickupNote: string | null } };

export type RideMutationResult = { requestId: string; revision: number; state: string; rideId?: string; arrangementId?: string };

/** Mirrors the backend coarse-area check so the form can explain the rule before sending. */
export function areaProblem(value: string): string | null {
  const area = value.trim().replace(/\s+/g, " ");
  if (!area) return "Enter a meeting area such as a neighborhood or landmark.";
  if (area.length > 60) return "Use 60 characters or fewer.";
  if (/@|https?:|www\./i.test(area) || /\d{2,}|\b\d+\s+[a-z]/i.test(area)) {
    return "Use a coarse area such as a neighborhood or landmark. Do not include an address, phone, email or link.";
  }
  return null;
}

export function rideSeatsLabel(kind: RideKind, seats: number): string {
  const unit = seats === 1 ? "seat" : "seats";
  return kind === "offer" ? `${seats} ${unit} open` : `Needs ${seats} ${unit}`;
}
