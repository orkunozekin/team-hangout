import { useCallback, useEffect, useRef, useState } from "react";
import { PILOT_ROLLBACK_CONFIRM, type PilotOperations as Report } from "../../shared/pilot";
import type { BrowserServices } from "./firebase";
import { errorCode, message } from "./errors";

function flagLabel(name: string, enabled: boolean) {
  return `${name} ${enabled ? "on" : "off"}`;
}

export function PilotOperations({
  services,
  orgId,
}: {
  services: BrowserServices;
  orgId: string;
}) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [rolling, setRolling] = useState(false);
  const generation = useRef(0);
  const load = useCallback(
    async (request: number) => {
      setLoading(true);
      try {
        const value = await services.call("listPilotOperations", { orgId });
        if (request !== generation.current) return;
        setReport(value);
        setError("");
      } catch (reason) {
        if (request !== generation.current) return;
        if (
          [
            "functions/permission-denied",
            "functions/unauthenticated",
            "functions/failed-precondition",
          ].includes(errorCode(reason))
        )
          setReport(null);
        setError(message(reason));
      } finally {
        if (request === generation.current) setLoading(false);
      }
    },
    [orgId, services],
  );
  useEffect(() => {
    const request = ++generation.current;
    setReport(null);
    setError("");
    setNotice("");
    setConfirmed(false);
    void load(request);
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void load(++generation.current);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);
  async function rollback() {
    setRolling(true);
    setError("");
    try {
      const result = await services.call("applyPilotRollback", {
        orgId,
        requestId: crypto.randomUUID(),
        confirm: PILOT_ROLLBACK_CONFIRM,
      });
      setNotice(
        `Phase 2 writers are off. History was kept. Quarantined publications: ${result.quarantinedOperationIds.length}${result.truncated ? " and more remain" : ""}.`,
      );
      setConfirmed(false);
      await load(++generation.current);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setRolling(false);
    }
  }
  return (
    <main id="main-content" tabIndex={-1} className="page diagnostics">
      <div className="page-heading">
        <div>
          <p className="eyebrow">Organization</p>
          <h1>Pilot operations</h1>
          <p>
            Counts only. Names, addresses, tokens, and file bytes stay off this page.
            Turning writers off keeps schedule, attendance, and message history.
          </p>
        </div>
        <button type="button" onClick={() => void load(++generation.current)} disabled={loading || rolling}>
          Reload pilot status
        </button>
      </div>
      {loading && !report ? <p role="status">Loading pilot operations…</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {report ? (
        <>
          <h2>Feature flags</h2>
          <div className="pilot-flags">
            {report.flags.map((flag) => (
              <span className="pilot-flag" key={flag.name}>{flagLabel(flag.name, flag.enabled)}</span>
            ))}
            <span className="pilot-flag">youth channels {report.youthChannels}</span>
          </div>
          <h2>Stuck publications</h2>
          <p>A publication is stuck when it is still in flight after {report.budgets.stuckAfterMinutes} minutes.</p>
          {report.stuckOperations.length ? (
            <div className="diagnostics-list">
              {report.stuckOperations.map((row) => (
                <article className="diagnostics-card" key={row.id}>
                  <h3>{row.id}</h3>
                  <p>{row.state}</p>
                  <p>{row.ageMinutes} minutes</p>
                </article>
              ))}
            </div>
          ) : (
            <p>No publication has been stuck for {report.budgets.stuckAfterMinutes} minutes.</p>
          )}
          {report.stuckTruncated ? <p>More stuck publications exist than this list shows.</p> : null}
          <h2>Attachments</h2>
          <p>
            Pending {report.attachments.pending}, uploading {report.attachments.uploading}, quarantined {report.attachments.quarantined}, canonicalizing {report.attachments.canonicalizing}, rejected {report.attachments.rejected}, ready {report.attachments.ready}.
            {report.attachments.truncated ? " Counts stop at 100." : ""}
          </p>
          <p>Each finalize and download holds up to {report.budgets.attachmentMaxBytes} bytes in a {report.budgets.functionMemory} function.</p>
          {report.rejections.length ? (
            <div className="diagnostics-list">
              {report.rejections.map((row) => (
                <article className="diagnostics-card" key={row.code}>
                  <h3>{row.code}</h3>
                  <p>{row.count}</p>
                </article>
              ))}
            </div>
          ) : (
            <p>No rejected attachments in this sample.</p>
          )}
          {report.rejectionsTruncated ? <p>Rejection counts stop at 100.</p> : null}
          <h2>Scanner</h2>
          <p>Mode {report.scanner.mode}. External scanner {report.scanner.externalConfigured ? "configured" : "not configured"}.</p>
          <h2>Rollback</h2>
          <div className="pilot-actions">
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              I understand new phase 2 writes stop and history stays
            </label>
            <button type="button" disabled={!confirmed || rolling || loading} onClick={() => void rollback()}>
              Disable phase 2 writers
            </button>
          </div>
        </>
      ) : null}
    </main>
  );
}
