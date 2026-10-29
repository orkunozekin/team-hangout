import { collection, doc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "./config";
import { runCommand } from "./commands";
import type { ReportCommands } from "../../shared/reports";

type Out<K extends keyof ReportCommands> = ReportCommands[K]["output"];

/** Hold one ID per intended request so an uncertain retry cannot queue a second run. */
export const reportRequestId = () => doc(collection(db, "commandRequests")).id;

/** Team-scoped attendance summary. The server rechecks the live coach assignment. */
export const requestTeamAttendanceReport = (
  orgId: string,
  scope: { programId: string; seasonId: string; teamId: string },
  dates: { fromDate: string; toDate: string },
  requestId: string,
) => runCommand<Out<"requestReport">>("requestReport", { orgId, filters: { kind: "attendance", ...scope, ...dates } }, requestId);

export async function listTeamReports(orgId: string, teamId: string): Promise<Out<"listReportRuns">> {
  return (await httpsCallable<Record<string, unknown>, Out<"listReportRuns">>(functions, "listReportRuns")({ orgId, teamId })).data;
}

export async function getReportRun(orgId: string, runId: string): Promise<Out<"getReportRun">> {
  return (await httpsCallable<Record<string, unknown>, Out<"getReportRun">>(functions, "getReportRun")({ orgId, runId })).data;
}
