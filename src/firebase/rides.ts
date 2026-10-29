import { httpsCallable } from "firebase/functions";
import { functions } from "./config";
import { runCommand } from "./commands";
import type { EventRides, RideContact, RideDirection, RideMutationResult } from "../../shared/rides";

export { volunteerRequestId as rideRequestId } from "./volunteers";

export async function getEventRides(eventId: string, teamId: string): Promise<EventRides> {
  return (await httpsCallable<Record<string, unknown>, EventRides>(functions, "getEventRides")({ eventId, teamId })).data;
}

/** Contacts are fetched on demand and never cached; the backend rechecks consent and authority on every call. */
export async function getRideContacts(eventId: string, teamId: string, arrangementId: string): Promise<RideContact> {
  return (await httpsCallable<Record<string, unknown>, RideContact>(functions, "getRideContacts")({ eventId, teamId, arrangementId })).data;
}

export type RideInput =
  | { kind: "offer"; direction: RideDirection; area: string; seats: number; discoverable: boolean }
  | { kind: "need"; direction: RideDirection; area: string; participantIds: string[]; discoverable: boolean };

/** Each helper takes the caller's request ID so an uncertain retry of the same intent cannot double-apply. */
export const saveRideRequest = (
  orgId: string, eventId: string, teamId: string, expectedRevision: number,
  payload: (RideInput & { rideId?: string }) | { rideId: string; action: "cancel" }, requestId: string,
) => runCommand<RideMutationResult>("saveRideRequest", { orgId, resourceId: eventId, expectedRevision, payload: { teamId, ...payload } }, requestId);

export type RideConsent = { displayAlias: string; contact: string; pickupNote: string | null };

export const confirmRideArrangement = (
  orgId: string, eventId: string, teamId: string,
  target: { arrangementId: string } | { offerId: string; needId: string }, consent: RideConsent, requestId: string,
) => runCommand<RideMutationResult>("confirmRideArrangement", {
  orgId, resourceId: eventId, expectedRevision: null, payload: { teamId, ...target, ...consent, shareContact: true },
}, requestId);

export const revokeRideConsent = (orgId: string, eventId: string, teamId: string, arrangementId: string, requestId: string) =>
  runCommand<RideMutationResult>("revokeRideConsent", { orgId, resourceId: eventId, expectedRevision: null, payload: { teamId, arrangementId } }, requestId);
