import { useEffect, useRef, useState } from "react";
import type {
  ScheduleDraft,
  SchedulePublication,
} from "../../shared/scheduleDrafts";
import type { BrowserServices } from "./firebase";
import { message, uncertain } from "./errors";
export function SchedulePublication({
  services,
  orgId,
  draft,
  eligible,
  onError,
  onPublication,
}: {
  services: BrowserServices;
  orgId: string;
  draft: ScheduleDraft;
  eligible: boolean;
  onError: (e: unknown) => void;
  onPublication: (id: string | null) => void;
}) {
  const [operation, setOperation] = useState<SchedulePublication | null>(null);
  const [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [retry, setRetry] = useState<
    (() => Promise<SchedulePublication>) | null
  >(null);
  const epoch = useRef(0),
    errorHandler = useRef(onError);
  errorHandler.current = onError;
  useEffect(() => {
    const n = ++epoch.current;
    let generation = 0;
    setOperation(null);
    setConfirmed(false);
    setRetry(null);
    setError("");
    const refresh = () => {
      const request = ++generation;
      void services
        .call("getSchedulePublication", { orgId, draftId: draft.draftId })
        .then((r) => {
          if (epoch.current === n && generation === request)
            setOperation(r.operation);
        })
        .catch((e) => {
          if (epoch.current === n && generation === request) {
            setError(message(e));
            errorHandler.current(e);
          }
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      epoch.current++;
      window.removeEventListener("focus", refresh);
    };
  }, [services, orgId, draft.draftId]);
  async function run(action: "start" | "advance" | "resume" | "abort") {
    const n = epoch.current;
    const base = {
      orgId,
      draftId: draft.draftId,
      requestId: crypto.randomUUID(),
    };
    const payload = operation
      ? {
          ...base,
          operationId: operation.operationId,
          expectedRevision: operation.revision,
          fencingToken: operation.fencingToken,
          action: action as "advance" | "resume" | "abort",
        }
      : null;
    const request =
      retry ??
      (payload
        ? () => services.call("advanceSchedulePublication", payload)
        : () =>
            services.call("publishScheduleDraft", {
              ...base,
              expectedRevision: draft.revision,
              confirmed: true,
            }));
    setBusy(true);
    setError("");
    try {
      const result = await request();
      if (epoch.current === n) {
        setOperation(result);
        onPublication(result.state === "aborted" ? null : result.operationId);
        setRetry(null);
      }
    } catch (e) {
      if (epoch.current === n) {
        setError(message(e));
        if (uncertain(e)) setRetry(() => request);
        onError(e);
      }
    } finally {
      if (epoch.current === n) setBusy(false);
    }
  }
  return (
    <section className="panel" aria-label="Schedule publication">
      <h2>Publish schedule</h2>
      <p>
        Review the complete schedule, then explicitly publish. Families see the
        batch only after every event is verified and committed.
      </p>
      {error && <p role="alert">{error}</p>}
      {!operation && (
        <>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || !!retry || !eligible}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I have reviewed this complete schedule and want to publish it.
          </label>
          <button
            disabled={busy || !!retry || !eligible || !confirmed}
            onClick={() => void run("start")}
          >
            Start publication
          </button>
        </>
      )}
      {operation && (
        <>
          <p role="status">
            {operation.state === "committed"
              ? "Published. The complete schedule is available to authorized teams and households."
              : operation.state === "aborted"
                ? "Publication aborted. Batch events remain hidden."
                : `Publication in progress: ${operation.state}. Batch is hidden from families.`}
          </p>
          <p>
            Staged {operation.stagingCursor} of {operation.total} · Promoted{" "}
            {operation.promotionCursor} of {operation.total}
          </p>
          <progress
            aria-label="Publication progress"
            max={operation.total * 2 + 1}
            value={
              operation.stagingCursor +
              operation.promotionCursor +
              (operation.state === "committed" ? 1 : 0)
            }
          />
          {!["committed", "aborted"].includes(operation.state) && (
            <div className="actions">
              <button
                disabled={busy || !!retry}
                onClick={() => void run("advance")}
              >
                {operation.state === "verifying"
                  ? "Verify and commit publication"
                  : "Continue next chunk"}
              </button>
              <button
                disabled={busy || !!retry}
                onClick={() => void run("resume")}
              >
                Resume interrupted publication
              </button>
              <button
                disabled={busy || !!retry}
                onClick={() => void run("abort")}
              >
                Abort hidden publication
              </button>
            </div>
          )}
        </>
      )}
      {retry && (
        <button disabled={busy} onClick={() => void run("advance")}>
          Retry same publication action
        </button>
      )}
      {busy && (
        <p role="status">Checking live authority and publication progress…</p>
      )}
    </section>
  );
}
