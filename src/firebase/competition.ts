import { httpsCallable } from "firebase/functions";
import { functions } from "./config";
import { runCommand } from "./commands";
import type { EventResults, ResultMutation, ResultValues } from "../../shared/competition";

export async function getEventResults(eventId: string, teamId: string): Promise<EventResults> {
  return (await httpsCallable<Record<string, unknown>, EventResults>(functions, "getEventResults")({ eventId, teamId })).data;
}

/** A coach proposes; only a competition scorer can finalize. Needs online acknowledgment. */
export const proposeResult = (
  orgId: string,
  competitionId: string,
  eventId: string,
  teamId: string,
  expectedRevision: number,
  result: ResultValues,
  requestId?: string,
) => runCommand<ResultMutation>(
  "proposeResult",
  { orgId, resourceId: competitionId, expectedRevision, payload: { eventId, teamId, result } },
  requestId,
);
