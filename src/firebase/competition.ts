import { httpsCallable } from "firebase/functions";
import { functions } from "./config";
import { runCommand } from "./commands";
import type { EventResults, EventStandings, ResultMutation, ResultValues } from "../../shared/competition";

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

/** Team viewer standings from a canonical event. Pass generationId with cursor to keep paging one table. */
export async function getEventStandings(
  eventId: string,
  teamId: string,
  options: { competitionId?: string; generationId?: string; cursor?: string } = {},
): Promise<EventStandings> {
  return (await httpsCallable<Record<string, unknown>, EventStandings>(functions, "getEventStandings")({ eventId, teamId, ...options })).data;
}
