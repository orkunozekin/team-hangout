import { formatDateTime } from "../../shared/dates";
import { useEffect, useRef, useState } from "react";
import type { AdminCommands } from "../../shared/admin";
import type { BrowserServices } from "./firebase";
import type {
  ClosurePreview,
  ClosureOperation,
  MakeupPreview,
} from "../../shared/closures";
import type { Facility, Resource } from "../../shared/facilities";
import { errorCode, message, uncertain } from "./errors";

type Props = { services: BrowserServices; orgId: string };
export function Closures({ services, orgId }: Props) {
  const [allowed, setAllowed] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [facilities, setFacilities] = useState<Facility[]>([]),
    [facilityCursor, setFacilityCursor] = useState<string | null>(null);
  const [facilityId, setFacility] = useState(""),
    [resources, setResources] = useState<Resource[]>([]),
    [resourceCursor, setResourceCursor] = useState<string | null>(null);
  const [resourceId, setResource] = useState(""),
    [startsAt, setStart] = useState(""),
    [endsAt, setEnd] = useState(""),
    [reason, setReason] = useState("");
  const [preview, setPreview] = useState<ClosurePreview | null>(null),
    [operation, setOperation] = useState<ClosureOperation | null>(null),
    [operationId, setOperationId] = useState("");
  const [confirmed, setConfirmed] = useState(false),
    [page, setPage] = useState(0);
  const [eventId, setEventId] = useState(""),
    [makeup, setMakeup] = useState<MakeupPreview | null>(null),
    [makeupConfirmed, setMakeupConfirmed] = useState(false),
    [notice, setNotice] = useState("");
  const [retry, setRetry] = useState<(() => Promise<void>) | null>(null);
  const alive = useRef(true),
    epoch = useRef(0);
  const deny = () => {
    epoch.current++;
    setEventId("");
    setReason("");
    setStart("");
    setEnd("");
    setNotice("");
    setAllowed(false);
    setPreview(null);
    setOperation(null);
    setMakeup(null);
    setRetry(null);
    setFacilities([]);
    setResources([]);
  };
  const fail = (e: unknown) => {
    if (
      ["functions/permission-denied", "functions/unauthenticated"].includes(
        errorCode(e),
      )
    )
      deny();
    setError(message(e));
  };
  async function call<K extends keyof AdminCommands>(
    name: K,
    data: AdminCommands[K]["input"],
  ): Promise<AdminCommands[K]["output"]> {
    const n = epoch.current;
    const result = await services.call(name, data);
    if (!alive.current || n !== epoch.current)
      throw new Error("Access changed. Reload the workspace.");
    return result;
  }
  useEffect(() => {
    alive.current = true;
    const n = epoch.current;
    const check = () => {
      void call("getAdminWorkspace", { orgId })
        .then((w) => {
          if (alive.current && epoch.current === n) {
            if (!w.admin) {
              deny();
              setError("Organization administrators manage shared closures.");
            } else setAllowed(true);
          }
        })
        .catch((e) => {
          if (alive.current && epoch.current === n) fail(e);
        });
    };
    check();
    void call("listFacilities", { orgId })
      .then((r) => {
        if (alive.current && epoch.current === n) {
          setFacilities(r.items);
          setFacilityCursor(r.nextCursor);
        }
      })
      .catch((e) => {
        if (alive.current && epoch.current === n) fail(e);
      });
    window.addEventListener("focus", check);
    return () => {
      alive.current = false;
      epoch.current++;
      window.removeEventListener("focus", check);
    };
  }, [services, orgId]);
  useEffect(() => {
    let active = true;
    setResources([]);
    setResource("");
    setResourceCursor(null);
    if (facilityId)
      void call("listFacilityResources", { orgId, facilityId })
        .then((r) => {
          if (active) {
            setResources(r.items);
            setResourceCursor(r.nextCursor);
          }
        })
        .catch((e) => {
          if (active) fail(e);
        });
    return () => {
      active = false;
    };
  }, [services, orgId, facilityId]);
  const invalidate = () => {
    setPreview(null);
    setMakeup(null);
    setConfirmed(false);
    setMakeupConfirmed(false);
    setNotice("");
  };
  async function run(action: () => Promise<void>) {
    const n = epoch.current,
      request = retry ?? action;
    setBusy(true);
    setError("");
    try {
      await request();
      if (alive.current && epoch.current === n) setRetry(null);
    } catch (e) {
      if (alive.current && epoch.current === n) {
        fail(e);
        if (uncertain(e)) setRetry(() => request);
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  // Action results must never populate a different or revoked tenant view.
  const saveOperation = (r: ClosureOperation) => {
    if (alive.current && allowed) {
      setOperation(r);
      setOperationId(r.operationId);
      setPreview(null);
      setPage(0);
    }
  };
  const disabled = busy || !!retry || !allowed;
  const impacted = operation?.impacted ?? preview?.impacted ?? [];
  const requestId = () => crypto.randomUUID();
  return (
    <main id="main-content" tabIndex={-1} className="page">
      <p className="eyebrow">League operations</p>
      <h1>Closures and makeups</h1>
      <p>
        Staff decide when to close a resource. Applying a reviewed closure
        closes the interval immediately. Event postponements then progress one
        at a time and can be resumed.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {busy && <p role="status">Checking current schedule…</p>}
      <fieldset disabled={disabled} className="panel">
        <legend>Review a closure or makeup time</legend>
        <label>
          Facility
          <select
            aria-label="Facility"
            value={facilityId}
            onChange={(e) => {
              setFacility(e.target.value);
              invalidate();
            }}
          >
            <option value="">Choose a facility</option>
            {facilities.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        {facilityCursor && (
          <button
            onClick={() => {
              const payload = { orgId, cursor: facilityCursor };
              void run(async () => {
                const r = await call("listFacilities", payload);
                setFacilities((v) => [...v, ...r.items]);
                setFacilityCursor(r.nextCursor);
              });
            }}
          >
            Load more facilities
          </button>
        )}
        <label>
          Resource
          <select
            aria-label="Resource"
            value={resourceId}
            onChange={(e) => {
              setResource(e.target.value);
              invalidate();
            }}
          >
            <option value="">Whole facility (all active resources)</option>
            {resources.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        {resourceCursor && (
          <button
            onClick={() => {
              const payload = { orgId, facilityId, cursor: resourceCursor };
              void run(async () => {
                const r = await call("listFacilityResources", payload);
                setResources((v) => [...v, ...r.items]);
                setResourceCursor(r.nextCursor);
              });
            }}
          >
            Load more resources
          </button>
        )}
        <p>
          Choose dates and times in UTC. The full occupied interval includes
          setup and cleanup.
        </p>
        <label>
          Starts at (UTC)
          <input
            type="datetime-local"
            step={60}
            value={startsAt.slice(0, 16)}
            onChange={(e) => {
              setStart(e.target.value ? `${e.target.value}:00.000Z` : "");
              invalidate();
            }}
          />
        </label>
        <label>
          Ends at (UTC)
          <input
            type="datetime-local"
            step={60}
            value={endsAt.slice(0, 16)}
            onChange={(e) => {
              setEnd(e.target.value ? `${e.target.value}:00.000Z` : "");
              invalidate();
            }}
          />
        </label>
        <label>
          Reason
          <input
            value={reason}
            maxLength={500}
            onChange={(e) => {
              setReason(e.target.value);
              invalidate();
            }}
          />
        </label>
        <button
          disabled={!facilityId || !startsAt || !endsAt || !reason}
          onClick={() => {
            const payload = {
              orgId,
              facilityId,
              resourceIds: resourceId ? [resourceId] : null,
              startsAt,
              endsAt,
              reason,
              requestId: requestId(),
            };
            void run(async () => {
              const r = await call("previewFacilityClosure", payload);
              if (alive.current) {
                setPreview(r);
                setOperation(null);
                setPage(0);
              }
            });
          }}
        >
          Preview closure impact
        </button>
      </fieldset>
      {(preview || operation) && (
        <section className="panel" aria-label="Closure impact">
          <h2>Affected teams and events</h2>
          <p>
            {impacted.length} affected events
            {preview ? ` across ${preview.resourceIds.length} resources` : ""}.
            Times and history are retained.
          </p>
          {impacted.slice(page * 10, page * 10 + 10).map((e, index) => (
            <article key={e.eventId}>
              <h3>{e.title}</h3>
              <p>
                {e.teamNames.join(" · ")} ·{" "}
                {formatDateTime(e.startsAt, e.timeZone)}
              </p>
              <p>
                {operation
                  ? operation.mismatches.includes(e.eventId)
                    ? "Changed event: needs staff reconciliation. No overwrite."
                    : page * 10 + index < operation.cursor
                      ? "Postponed. Awaiting a reviewed makeup."
                      : "Resource closed. Postponement update pending."
                  : "Will be postponed if this preview is applied."}
              </p>
            </article>
          ))}
          {!impacted.length && (
            <p>No scheduled events overlap this interval.</p>
          )}
          <div className="actions">
            <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Previous impacts
            </button>
            <button
              disabled={(page + 1) * 10 >= impacted.length}
              onClick={() => setPage((p) => p + 1)}
            >
              More impacts
            </button>
          </div>
          {preview && (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={disabled}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                I reviewed the affected teams and want to close this interval.
              </label>
              <button
                disabled={disabled || !confirmed}
                onClick={() => {
                  const payload = {
                    orgId,
                    previewId: preview.previewId,
                    previewHash: preview.previewHash,
                    confirmed: true,
                    requestId: requestId(),
                  };
                  void run(async () =>
                    saveOperation(await call("applyFacilityClosure", payload)),
                  );
                }}
              >
                Apply reviewed closure
              </button>
            </>
          )}
        </section>
      )}
      <section className="panel" aria-label="Closure recovery">
        <h2>Closure progress and recovery</h2>
        <label>
          Operation ID
          <input
            value={operationId}
            disabled={disabled}
            onChange={(e) => setOperationId(e.target.value)}
          />
        </label>
        <button
          disabled={disabled || !operationId}
          onClick={() => {
            const payload = { orgId, operationId };
            void run(async () =>
              saveOperation(await call("getFacilityClosureOperation", payload)),
            );
          }}
        >
          Reload closure progress
        </button>
        {operation && (
          <>
            <p role="status">
              Interval closed. {operation.postponed} postponed ·{" "}
              {operation.cursor} of {operation.total} processed ·{" "}
              {operation.mismatches.length} need reconciliation.
            </p>
            <p>
              Operation {operation.operationId} · {operation.state}
            </p>
            <progress
              aria-label="Closure progress"
              max={Math.max(1, operation.total)}
              value={operation.cursor}
            />
            {operation.state !== "committed" && (
              <div className="actions">
                {(["advance", "resume"] as const).map((action) => (
                  <button
                    key={action}
                    disabled={disabled}
                    onClick={() => {
                      const payload = {
                        orgId,
                        operationId: operation.operationId,
                        expectedRevision: operation.revision,
                        fencingToken: operation.fencingToken,
                        action,
                        requestId: requestId(),
                      };
                      void run(async () =>
                        saveOperation(
                          await call("advanceFacilityClosure", payload),
                        ),
                      );
                    }}
                  >
                    {action === "advance"
                      ? "Continue next event"
                      : "Resume interrupted closure"}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </section>
      <section className="panel" aria-label="Reviewed makeup">
        <h2>Review a makeup</h2>
        <p>
          Choose a postponed event and a specific open resource above. Current
          resources, teams and coaches are checked again at confirmation. Other
          organizations’ coach conflicts are not checked.
        </p>
        <label>
          Postponed event ID
          <input
            disabled={disabled}
            value={eventId}
            onChange={(e) => {
              setEventId(e.target.value);
              setMakeup(null);
              setMakeupConfirmed(false);
            }}
          />
        </label>
        <button
          disabled={
            disabled ||
            !eventId ||
            !resourceId ||
            !startsAt ||
            !endsAt ||
            !reason
          }
          onClick={() => {
            const event = eventId,
              patch = { startsAt, endsAt, facilityId, resourceId },
              why = reason,
              req = requestId();
            let payload:
              AdminCommands["previewEventMakeup"]["input"] | undefined;
            void run(async () => {
              if (!payload) {
                const e = await call("getCanonicalEvent", { eventId: event });
                payload = {
                  orgId,
                  eventId: event,
                  expectedRevision: e.revision,
                  patch: { ...patch, timeZone: e.timeZone },
                  reason: why,
                  requestId: req,
                };
              }
              const r = await call("previewEventMakeup", payload);
              if (alive.current) {
                setMakeup(r);
                setMakeupConfirmed(false);
              }
            });
          }}
        >
          Preview makeup
        </button>
        {makeup && (
          <>
            <h3>Makeup preview: {makeup.title}</h3>
            <p>
              {formatDateTime(makeup.previousStartsAt, makeup.timeZone)} →{" "}
              {formatDateTime(makeup.startsAt, makeup.timeZone)} until{" "}
              {formatDateTime(makeup.endsAt, makeup.timeZone)} (
              {makeup.timeZone}). The event keeps its identity and history.
            </p>
            <label>
              <input
                type="checkbox"
                checked={makeupConfirmed}
                disabled={disabled}
                onChange={(e) => setMakeupConfirmed(e.target.checked)}
              />
              I reviewed this makeup and want to reschedule the same event.
            </label>
            <button
              disabled={disabled || !makeupConfirmed}
              onClick={() => {
                const payload = {
                  orgId,
                  previewId: makeup.previewId,
                  previewHash: makeup.previewHash,
                  confirmed: true,
                  requestId: requestId(),
                };
                void run(async () => {
                  await call("confirmEventMakeup", payload);
                  if (alive.current) {
                    setMakeup(null);
                    setNotice(
                      "Makeup confirmed. The existing event is rescheduled with its history retained.",
                    );
                  }
                });
              }}
            >
              Confirm reviewed makeup
            </button>
          </>
        )}
      </section>
      {retry && (
        <button disabled={busy} onClick={() => void run(retry)}>
          Retry same action
        </button>
      )}
    </main>
  );
}
