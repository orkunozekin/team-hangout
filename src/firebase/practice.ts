import { httpsCallable } from "firebase/functions";
import { collection, doc } from "firebase/firestore";
import { db, functions } from "./config";
import { runCommand } from "./commands";
import type { CoachResource, EventPracticePlan, PlanItemInput } from "../../shared/practiceResources";

export async function getEventPracticePlan(eventId: string, teamId: string): Promise<EventPracticePlan> {
  return (
    await httpsCallable<Record<string, unknown>, EventPracticePlan>(functions, "getEventPracticePlan")({ eventId, teamId })
  ).data;
}

export type ResourcePage = { programId: string; items: CoachResource[]; nextCursor: string | null };

/** Published, unexpired resources for the coach's team program. Pages follow the server cursor. */
export async function listTeamPracticeResources(orgId: string, teamId: string, age: number | null, cursor: string | null): Promise<ResourcePage> {
  return (
    await httpsCallable<Record<string, unknown>, ResourcePage>(functions, "listPracticeResources")({
      orgId, teamId, pageSize: 10, ...(age != null ? { age } : {}), ...(cursor ? { cursor } : {}),
    })
  ).data;
}

type PlanResult = { requestId: string; revision: number; state: "private" | "published" };

export const savePracticePlan = (
  orgId: string,
  eventId: string,
  teamId: string,
  expectedRevision: number,
  payload: { action: "save"; items: PlanItemInput[]; householdNote: string; privateNote: string } | { action: "publish" | "retract" },
  requestId: string,
) => runCommand<PlanResult>("savePracticePlan", { orgId, resourceId: eventId, expectedRevision, payload: { teamId, ...payload } }, requestId);

export const practiceRequestId = () => doc(collection(db, "commandRequests")).id;
