import { useCallback, useEffect, useRef, useState } from "react";
import type { DeliveryDiagnostics as Report } from "../../shared/reminders";
import type { BrowserServices } from "./firebase";
import { errorCode, message } from "./errors";

function when(value: string | null) {
  if (!value) return "Time unavailable";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Time unavailable"
    : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function DeliveryDiagnostics({
  services,
  orgId,
}: {
  services: BrowserServices;
  orgId: string;
}) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const load = useCallback(
    async (request: number, cursors?: { failureCursor?: string | null; acknowledgementCursor?: string | null }) => {
      setLoading(true);
      try {
        const value = await services.call("listDeliveryDiagnostics", {
          orgId,
          pageSize: 25,
          ...(cursors?.failureCursor ? { failureCursor: cursors.failureCursor } : {}),
          ...(cursors?.acknowledgementCursor
            ? { acknowledgementCursor: cursors.acknowledgementCursor }
            : {}),
        });
        if (request !== generation.current) return;
        setReport((current) => {
          if (!current || !cursors) return value;
          return {
            failures: cursors.failureCursor
              ? {
                  items: [...current.failures.items, ...value.failures.items],
                  nextCursor: value.failures.nextCursor,
                }
              : current.failures,
            unacknowledged: cursors.acknowledgementCursor
              ? {
                  items: [...current.unacknowledged.items, ...value.unacknowledged.items],
                  nextCursor: value.unacknowledged.nextCursor,
                }
              : current.unacknowledged,
          };
        });
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
    void load(request);
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      void load(++generation.current);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      generation.current += 1;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);
  return (
    <main id="main-content" tabIndex={-1} className="page diagnostics">
      <p className="eyebrow">Operations</p>
      <div className="page-heading">
        <div>
          <h1>Delivery diagnostics</h1>
          <p className="muted">
            Provider failures and human acknowledgements are different facts.
            A bounced message or expired device token is not an acknowledgement,
            and an unacknowledged critical update is not a delivery failure.
          </p>
        </div>
        <button type="button" onClick={() => void load(++generation.current)}>
          Reload diagnostics
        </button>
      </div>
      {loading && !report ? <p role="status">Loading delivery diagnostics…</p> : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {report ? (
        <>
          <section aria-labelledby="delivery-failures">
            <h2 id="delivery-failures">Delivery failures</h2>
            <p>
              These rows are transport results. They do not mean someone read
              or acknowledged the update.
            </p>
            {report.failures.items.length === 0 ? (
              <p>No delivery failures.</p>
            ) : (
              <div className="diagnostics-list">
                {report.failures.items.map((row) => (
                  <article className="diagnostics-card" key={row.id}>
                    <h3>{row.failureCode ?? "Delivery failed"}</h3>
                    <p>
                      {row.channel} · {row.status}
                      {row.templateKey ? ` · ${row.templateKey}` : ""}
                    </p>
                    <p className="muted">Updated {when(row.updatedAt)}</p>
                  </article>
                ))}
              </div>
            )}
            {report.failures.nextCursor ? (
              <button
                type="button"
                disabled={loading}
                onClick={() =>
                  void load(++generation.current, {
                    failureCursor: report.failures.nextCursor,
                  })
                }
              >
                Show more delivery failures
              </button>
            ) : null}
          </section>
          <section aria-labelledby="unacknowledged-critical">
            <h2 id="unacknowledged-critical">Unacknowledged critical updates</h2>
            <p>Not acknowledged. This list is not a delivery-failure report.</p>
            {report.unacknowledged.items.length === 0 ? (
              <p>No unacknowledged critical updates.</p>
            ) : (
              <div className="diagnostics-list">
                {report.unacknowledged.items.map((row) => (
                  <article className="diagnostics-card" key={row.id}>
                    <h3>{row.title}</h3>
                    <p>Not acknowledged</p>
                    <p className="muted">
                      {row.templateKey ?? "Critical update"} · revision{" "}
                      {row.sourceRevision ?? "unknown"} · {when(row.createdAt)}
                    </p>
                  </article>
                ))}
              </div>
            )}
            {report.unacknowledged.nextCursor ? (
              <button
                type="button"
                disabled={loading}
                onClick={() =>
                  void load(++generation.current, {
                    acknowledgementCursor: report.unacknowledged.nextCursor,
                  })
                }
              >
                Show more unacknowledged updates
              </button>
            ) : null}
          </section>
        </>
      ) : null}
    </main>
  );
}
