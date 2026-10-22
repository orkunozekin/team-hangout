import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { PILOT_STUCK_AFTER_MS } from "./pilot";

const SCAN_WINDOW_MS = 15 * 60 * 1000;
const REPEATED_SCAN_FAILURES = 3;
const SAMPLE = 100;

type Alert = { code: "PUBLICATION_STUCK" | "DELETION_STUCK" | "SCAN_FAILED_REPEATED" | "CLEANUP_RETRY_REQUIRED"; count: number; truncated: boolean };

export function phase2AlertSummaries(input: {
  publicationAgesMs: number[];
  deletionAgesMs: number[];
  scanFailureAgesMs: number[];
  cleanupRetryCount: number;
}): Alert[] {
  const alerts: Alert[] = [];
  const publications = input.publicationAgesMs.filter((age) => age >= PILOT_STUCK_AFTER_MS);
  const deletions = input.deletionAgesMs.filter((age) => age >= PILOT_STUCK_AFTER_MS);
  const scans = input.scanFailureAgesMs.filter((age) => age >= 0 && age <= SCAN_WINDOW_MS);
  if (publications.length) alerts.push({ code: "PUBLICATION_STUCK", count: Math.min(publications.length, 25), truncated: publications.length > 25 });
  if (deletions.length) alerts.push({ code: "DELETION_STUCK", count: Math.min(deletions.length, 25), truncated: deletions.length > 25 });
  if (scans.length >= REPEATED_SCAN_FAILURES) alerts.push({ code: "SCAN_FAILED_REPEATED", count: Math.min(scans.length, SAMPLE), truncated: scans.length > SAMPLE });
  if (input.cleanupRetryCount > 0) alerts.push({ code: "CLEANUP_RETRY_REQUIRED", count: Math.min(input.cleanupRetryCount, 25), truncated: input.cleanupRetryCount > 25 });
  return alerts;
}

function age(value: unknown, nowMs: number) {
  return value instanceof Timestamp ? Math.max(0, nowMs - value.toMillis()) : Number.POSITIVE_INFINITY;
}

export const monitorPhase2Pilot = onSchedule({ schedule: "every 5 minutes", timeoutSeconds: 120 }, async () => {
  const db = getFirestore();
  const config = (await db.doc("platformConfig/phase2Monitoring").get()).data();
  if (config?.enabled !== true) return;
  const organizationIds = Array.isArray(config.organizationIds)
    ? [...new Set(config.organizationIds.filter((item: unknown): item is string => typeof item === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(item)))].slice(0, 10)
    : [];
  if (!organizationIds.length) return;
  const nowMs = Date.now();
  const publicationAgesMs: number[] = [];
  const scanFailureAgesMs: number[] = [];
  for (const orgId of organizationIds) {
    const [publications, scanFailures] = await Promise.all([
      db.collection(`organizations/${orgId}/scheduleOperations`)
        .where("state", "in", ["staging", "promoting", "verifying"])
        .orderBy("updatedAt", "asc")
        .limit(26)
        .get(),
      db.collection(`organizations/${orgId}/attachments`)
        .where("state", "==", "rejected")
        .where("rejectionCode", "==", "SCAN_FAILED")
        .orderBy("updatedAt", "desc")
        .limit(SAMPLE + 1)
        .get(),
    ]);
    publicationAgesMs.push(...publications.docs.map((doc) => age(doc.get("updatedAt"), nowMs)));
    scanFailureAgesMs.push(...scanFailures.docs.map((doc) => age(doc.get("updatedAt"), nowMs)));
  }
  const [deletions, cleanupRetries] = await Promise.all([
    db.collection("accountDeletionJobs").where("status", "==", "pending").orderBy("updatedAt", "asc").limit(26).get(),
    db.collection("accountDeletionJobs").where("lastError", "==", "CLEANUP_RETRY_REQUIRED").limit(26).get(),
  ]);
  const alerts = phase2AlertSummaries({
    publicationAgesMs,
    deletionAgesMs: deletions.docs.map((doc) => age(doc.get("updatedAt"), nowMs)),
    scanFailureAgesMs,
    cleanupRetryCount: cleanupRetries.size,
  });
  for (const alert of alerts) console.error("Phase 2 pilot alert.", { ...alert, monitoredOrganizations: organizationIds.length });
});
