import { httpsCallable } from "firebase/functions";
import { collection, doc } from "firebase/firestore";
import { db, functions } from "./config";
import { runCommand } from "./commands";
import type {
  LineupMutationResult,
  PrivateLineup,
  PublishedLineupView,
  SaveLineupPayload,
} from "../../shared/lineups";

export async function getLineup(eventId: string, teamId: string): Promise<PrivateLineup> {
  return (
    await httpsCallable<Record<string, unknown>, PrivateLineup>(functions, "getLineup")({ eventId, teamId })
  ).data;
}

export async function getLineupView(
  eventId: string,
  teamId: string,
  participantId?: string,
): Promise<PublishedLineupView> {
  return (
    await httpsCallable<Record<string, unknown>, PublishedLineupView>(functions, "getLineupView")({
      eventId,
      teamId,
      ...(participantId ? { participantId } : {}),
    })
  ).data;
}

/** The caller keeps one request ID per intended change so an uncertain retry cannot double-apply. */
export const saveLineup = (
  orgId: string,
  eventId: string,
  expectedRevision: number,
  payload: SaveLineupPayload,
  requestId: string,
) => runCommand<LineupMutationResult>(
  "saveLineup",
  { orgId, resourceId: eventId, expectedRevision, payload },
  requestId,
);

export const publishLineup = (
  orgId: string,
  eventId: string,
  teamId: string,
  expectedRevision: number,
  action: "publish" | "retract",
  requestId: string,
) => runCommand<LineupMutationResult>(
  "publishLineup",
  { orgId, resourceId: eventId, expectedRevision, payload: { teamId, action } },
  requestId,
);

export const lineupRequestId = () => doc(collection(db, "commandRequests")).id;
