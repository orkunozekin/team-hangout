import { httpsCallable } from "firebase/functions";
import { collection, doc } from "firebase/firestore";
import { db, functions } from "./config";
import { runCommand } from "./commands";
import type { EventAvailability } from "../../shared/availability";
export const availabilityRequestId = () =>
  doc(collection(db, "commandRequests")).id;
export async function getEventAvailability(
  eventId: string,
): Promise<EventAvailability> {
  return (
    await httpsCallable<{ eventId: string }, EventAvailability>(
      functions,
      "getEventAvailability",
    )({ eventId })
  ).data;
}
export const respondToEvent = (
  payload: Record<string, unknown>,
  requestId: string,
) => runCommand("respondToEvent", payload, requestId);
export const setEventRsvpDeadline = (
  eventId: string,
  expectedRevision: number,
  deadline: string | null,
) =>
  runCommand("setEventRsvpDeadline", { eventId, expectedRevision, deadline });
