import { httpsCallable } from "firebase/functions";
import { functions } from "./config";
import { runCommand } from "./commands";
import type { PlayActionPayload, PlayMutationResult, PlaySession } from "../../shared/playTime";

export async function getPlaySession(eventId: string, teamId: string): Promise<PlaySession> {
  return (
    await httpsCallable<Record<string, unknown>, PlaySession>(functions, "getPlaySession")({ eventId, teamId })
  ).data;
}

/** Clock writes need online acknowledgment; nothing is queued for later. */
export const recordPlayAction = (
  orgId: string,
  eventId: string,
  teamId: string,
  expectedRevision: number,
  action: PlayActionPayload,
  requestId?: string,
) => runCommand<PlayMutationResult>(
  "recordPlayAction",
  { orgId, resourceId: eventId, expectedRevision, payload: { teamId, ...action } },
  requestId,
);

export const finalizePlaySession = (
  orgId: string,
  eventId: string,
  teamId: string,
  expectedRevision: number,
  requestId?: string,
) => runCommand<PlayMutationResult>(
  "finalizePlaySession",
  { orgId, resourceId: eventId, expectedRevision, payload: { teamId } },
  requestId,
);
