import { httpsCallable } from "firebase/functions";
import { functions } from "./config";
import { runCommand } from "./commands";
import type { ParticipantCheckIn, CheckInPolicy } from "../../shared/checkIn";
export async function getParticipantCheckIn(
  eventId: string,
  participantId: string,
): Promise<ParticipantCheckIn> {
  return (
    await httpsCallable<
      { eventId: string; participantId: string },
      ParticipantCheckIn
    >(
      functions,
      "getParticipantCheckIn",
    )({ eventId, participantId })
  ).data;
}
export const checkInParticipant = (
  payload: Record<string, unknown>,
  requestId: string,
) => runCommand("checkInParticipant", payload, requestId);
export const setEventCheckInPolicy = (
  eventId: string,
  expectedRevision: number,
  policy: CheckInPolicy,
) => runCommand("setEventCheckInPolicy", { eventId, expectedRevision, policy });
