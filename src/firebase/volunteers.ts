import { httpsCallable } from "firebase/functions";
import { collection, doc } from "firebase/firestore";
import { db, functions } from "./config";
import { runCommand } from "./commands";
import type { EventVolunteers, VolunteerKind, VolunteerMutationResult } from "../../shared/volunteers";

export async function getEventVolunteers(eventId: string, teamId: string): Promise<EventVolunteers> {
  return (
    await httpsCallable<Record<string, unknown>, EventVolunteers>(functions, "getEventVolunteers")({ eventId, teamId })
  ).data;
}

export type SlotInput = { kind: VolunteerKind; title: string; capacity: number; claimDeadline: string | null };

/** Each helper takes the caller's request ID so an uncertain retry of the same intent cannot double-apply. */
export const saveVolunteerSlot = (
  orgId: string,
  eventId: string,
  teamId: string,
  expectedRevision: number,
  payload: ({ slotId?: string } & SlotInput) | { slotId: string; action: "cancel" },
  requestId: string,
) => runCommand<VolunteerMutationResult>(
  "saveVolunteerSlot",
  { orgId, resourceId: eventId, expectedRevision, payload: { teamId, ...payload } },
  requestId,
);

export const claimVolunteerSlot = (orgId: string, eventId: string, teamId: string, slotId: string, displayAlias: string, requestId: string) =>
  runCommand<VolunteerMutationResult>(
    "claimVolunteerSlot",
    { orgId, resourceId: eventId, expectedRevision: null, payload: { teamId, slotId, displayAlias, showAlias: true } },
    requestId,
  );

export const releaseVolunteerSlot = (orgId: string, eventId: string, teamId: string, slotId: string, requestId: string, assigneeKey?: string) =>
  runCommand<VolunteerMutationResult>(
    "releaseVolunteerSlot",
    { orgId, resourceId: eventId, expectedRevision: null, payload: { teamId, slotId, ...(assigneeKey ? { assigneeKey } : {}) } },
    requestId,
  );

export const volunteerRequestId = () => doc(collection(db, "commandRequests")).id;
