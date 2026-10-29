import { getFirestore, Query, Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { onSchedule } from "firebase-functions/v2/scheduler";

/** Longer than the 10 minute reconcile schedules plus one lease, so an alert means reconciliation did not recover it. */
export const PHASE3_STUCK_AFTER_MS = 25 * 60 * 1000;
export const PHASE3_FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;
const CAP = 25;

export type Phase3AlertCode =
  | "STANDINGS_STALE"
  | "STANDINGS_BUILD_ABANDONED"
  | "REPORT_QUEUED_STUCK"
  | "REPORT_LEASE_EXPIRED"
  | "REPORT_FAILED"
  | "ROLLOVER_QUEUED_STUCK"
  | "ROLLOVER_LEASE_EXPIRED"
  | "ROLLOVER_FAILED";
type Alert = { code: Phase3AlertCode; count: number; truncated: boolean };

/** Bounded counts only: no organization, resource, actor or failure-message details leave the probe. */
export function phase3AlertSummaries(counts: Partial<Record<Phase3AlertCode, number>>): Alert[] {
  const order: Phase3AlertCode[] = ["STANDINGS_STALE", "STANDINGS_BUILD_ABANDONED", "REPORT_QUEUED_STUCK", "REPORT_LEASE_EXPIRED",
    "REPORT_FAILED", "ROLLOVER_QUEUED_STUCK", "ROLLOVER_LEASE_EXPIRED", "ROLLOVER_FAILED"];
  return order.flatMap((code) => {
    const count = Math.max(0, Math.floor(counts[code] ?? 0));
    return count ? [{ code, count: Math.min(count, CAP), truncated: count > CAP }] : [];
  });
}

/** Counts tenant documents only; each query reads at most CAP + 1 documents through an existing collection-group index. */
async function count(query: Query, parent: "competitions" | "organizations") {
  const snapshot = await query.limit(CAP + 1).get();
  return snapshot.docs.filter((doc) => {
    const owner = doc.ref.parent.parent;
    return parent === "competitions" ? owner?.parent.id === "competitions" : owner?.parent.id === "organizations";
  }).length;
}

export async function collectPhase3Alerts(nowMs = Date.now()) {
  const db = getFirestore();
  const stuck = Timestamp.fromMillis(nowMs - PHASE3_STUCK_AFTER_MS);
  const recent = Timestamp.fromMillis(nowMs - PHASE3_FAILED_WINDOW_MS);
  // Failures are windowed by when they failed (reports stamp finishedAt, rollovers failedAt), not by when they were queued.
  const jobs = (group: "reportRuns" | "rolloverJobs", running: "building" | "running", failedAt: "finishedAt" | "failedAt") => [
    count(db.collectionGroup(group).where("state", "==", "queued").where("queuedAt", "<=", stuck).orderBy("queuedAt"), "organizations"),
    count(db.collectionGroup(group).where("state", "==", running).where("leaseExpiresAt", "<=", stuck).orderBy("leaseExpiresAt"), "organizations"),
    count(db.collectionGroup(group).where("state", "==", "failed").where(failedAt, ">=", recent).orderBy(failedAt), "organizations"),
  ];
  const [standings, builds, reportQueued, reportLease, reportFailed, rolloverQueued, rolloverLease, rolloverFailed] = await Promise.all([
    count(db.collectionGroup("competitions").where("standingsPendingSince", "<=", stuck).orderBy("standingsPendingSince"), "organizations"),
    count(db.collectionGroup("generations").where("state", "==", "building").where("startedAt", "<=", stuck).orderBy("startedAt"), "competitions"),
    ...jobs("reportRuns", "building", "finishedAt"),
    ...jobs("rolloverJobs", "running", "failedAt"),
  ]);
  return phase3AlertSummaries({
    STANDINGS_STALE: standings,
    STANDINGS_BUILD_ABANDONED: builds,
    REPORT_QUEUED_STUCK: reportQueued,
    REPORT_LEASE_EXPIRED: reportLease,
    REPORT_FAILED: reportFailed,
    ROLLOVER_QUEUED_STUCK: rolloverQueued,
    ROLLOVER_LEASE_EXPIRED: rolloverLease,
    ROLLOVER_FAILED: rolloverFailed,
  });
}

/** Read-only pilot probe. Off unless an operator sets platformConfig/phase3Monitoring.enabled to true. */
export const monitorPhase3Pilot = onSchedule({ schedule: "every 15 minutes", timeoutSeconds: 120 }, async () => {
  const config = (await getFirestore().doc("platformConfig/phase3Monitoring").get()).data();
  if (config?.enabled !== true) return;
  for (const alert of await collectPhase3Alerts()) logger.write({ severity: "ERROR", message: "Phase 3 pilot alert.", ...alert });
});
