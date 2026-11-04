import {
  formatCalendarDate,
  formatDateTime,
  formatClockTime,
} from "../../shared/dates";
import { useEffect, useRef, useState } from "react";
import type {
  RecurrenceInput,
  RecurrencePreview,
  SeriesFields,
} from "../../shared/recurrence";
import type { BrowserServices } from "./firebase";
import { errorCode, message, uncertain } from "./errors";
const initial: SeriesFields = {
  title: "",
  startsOn: "",
  endsOn: "",
  weekdays: [0],
  localTime: "17:00",
  timeZone: "",
  durationMinutes: 60,
  exclusions: [],
  offsets: {},
  facilityId: null,
  resourceId: null,
};
export function Recurrence({
  services,
  orgId,
}: {
  services: BrowserServices;
  orgId: string;
}) {
  const epoch = useRef(0);
  const capability = useRef<string | null>(null);
  const authorizationRead = useRef(0);
  const [ready, setReady] = useState(false),
    [denied, setDenied] = useState(false);
  const [fields, setFields] = useState(initial),
    [teamId, setTeamId] = useState("");
  const [seriesId, setSeriesId] = useState<string>(() => crypto.randomUUID()),
    [loadId, setLoadId] = useState(""),
    [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<RecurrencePreview | null>(null),
    [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [retry, setRetry] = useState<(() => Promise<unknown>) | null>(null);
  const fail = (e: unknown) => {
    if (
      ["functions/permission-denied", "functions/unauthenticated"].includes(
        errorCode(e),
      )
    ) {
      epoch.current++;
      setDenied(true);
      setPreview(null);
      setFields(initial);
      setTeamId("");
      setRetry(null);
      setNotice("");
      setError("Access unavailable. Reload to recheck staff access.");
    } else setError(message(e));
  };
  useEffect(() => {
    let alive = true;
    const authorize = async () => {
      const request = ++authorizationRead.current;
      try {
        const context = await services.call("getAdminWorkspace", { orgId });
        if (!alive || request !== authorizationRead.current) return;
        const signature = JSON.stringify([
          context.admin,
          [...context.programIds].sort(),
          context.organization.status,
        ]);
        if (capability.current !== null && capability.current !== signature) {
          fail({ code: "functions/permission-denied" });
          return;
        }
        capability.current = signature;
        setReady(true);
        setFields((current) =>
          current.timeZone
            ? current
            : { ...current, timeZone: context.organization.timeZone || "" },
        );
      } catch (e) {
        if (alive && request === authorizationRead.current) fail(e);
      }
    };
    void authorize();
    window.addEventListener("focus", authorize);
    return () => {
      alive = false;
      epoch.current++;
      window.removeEventListener("focus", authorize);
    };
  }, [services, orgId]);
  const change = (patch: Partial<SeriesFields>) => {
    epoch.current++;
    setFields((f) => ({ ...f, ...patch }));
    setPreview(null);
    setReviewed(false);
    setNotice("");
    setError("");
  };
  const input = (): RecurrenceInput => ({
    orgId,
    teamId,
    seriesId,
    expectedRevision: revision,
    fields,
  });
  async function read(load: boolean) {
    const request = ++epoch.current;
    setBusy(true);
    setError("");
    setNotice("");
    setPreview(null);
    setReviewed(false);
    try {
      if (load) {
        const result = await services.call("getRecurrenceDraft", {
          orgId,
          seriesId: loadId,
        });
        if (request !== epoch.current) return;
        setSeriesId(result.seriesId);
        setTeamId(result.teamId);
        setRevision(result.revision);
        setFields(result.fields);
        setNotice(
          `Loaded draft revision ${result.revision}. Preview again to review current conditions.`,
        );
      } else {
        const result = await services.call("previewRecurrenceDraft", input());
        if (request === epoch.current) setPreview(result);
      }
    } catch (e) {
      if (request === epoch.current) fail(e);
    } finally {
      if (request === epoch.current) setBusy(false);
    }
  }
  async function save() {
    if (!retry && (!preview || !reviewed)) return;
    const payload = {
      ...input(),
      requestId: crypto.randomUUID(),
      previewHash: preview?.previewHash || "",
      reviewed: true as const,
    };
    const action =
      retry || (() => services.call("saveRecurrenceDraft", payload));
    const request = epoch.current;
    setBusy(true);
    setError("");
    try {
      const result = (await action()) as { seriesId: string; revision: number };
      if (request !== epoch.current) return;
      setRetry(null);
      setRevision(result.revision);
      setPreview(null);
      setReviewed(false);
      setNotice(
        `Saved reviewed draft revision ${result.revision}. Series ID: ${result.seriesId}. No events were published or reserved.`,
      );
    } catch (e) {
      if (request !== epoch.current) return;
      setRetry(uncertain(e) ? () => action : null);
      fail(e);
    } finally {
      if (request === epoch.current) setBusy(false);
    }
  }
  return (
    <main id="main-content" className="page">
      <a href={`/organizations/${orgId}/program`}>← Organization workspace</a>
      <p className="eyebrow">Schedule preparation</p>
      <h1>Recurring practice drafts</h1>
      <p>
        Review a finite season range, then save a staff-only draft. Drafts do
        not publish events or reserve fields. Availability must be checked again
        before any future publication.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {!ready && !denied && <p role="status">Checking staff access…</p>}
      {ready && !denied && (
        <>
          <fieldset disabled={busy || !!retry}>
            <section className="panel">
              <h2>Series and season range</h2>
              <label>
                Existing series ID
                <input
                  value={loadId}
                  onChange={(e) => setLoadId(e.target.value)}
                />
              </label>
              <button
                type="button"
                onClick={() => void read(true)}
                disabled={!loadId}
              >
                Load draft
              </button>
              <p className="small muted">
                Current series: {seriesId} · Revision {revision}. Revisions
                preserve occurrence identities.
              </p>
              <label>
                Team ID
                <input
                  value={teamId}
                  disabled={revision > 0}
                  onChange={(e) => {
                    epoch.current++;
                    setTeamId(e.target.value);
                    setPreview(null);
                    setReviewed(false);
                  }}
                />
              </label>
              <label>
                Practice title
                <input
                  value={fields.title}
                  onChange={(e) => change({ title: e.target.value })}
                />
              </label>
              <div className="form-grid">
                <label>
                  First local date
                  <input
                    type="date"
                    value={fields.startsOn}
                    onChange={(e) =>
                      change({ startsOn: e.target.value, offsets: {} })
                    }
                  />
                </label>
                <label>
                  Last local date
                  <input
                    type="date"
                    value={fields.endsOn}
                    onChange={(e) =>
                      change({ endsOn: e.target.value, offsets: {} })
                    }
                  />
                </label>
                <label>
                  Local start time
                  <input
                    type="time"
                    value={fields.localTime}
                    onChange={(e) =>
                      change({ localTime: e.target.value, offsets: {} })
                    }
                  />
                </label>
                <label>
                  IANA timezone
                  <input
                    value={fields.timeZone}
                    onChange={(e) =>
                      change({ timeZone: e.target.value, offsets: {} })
                    }
                  />
                </label>
                <label>
                  Duration in minutes
                  <input
                    type="number"
                    min="1"
                    max="1440"
                    value={fields.durationMinutes}
                    onChange={(e) =>
                      change({ durationMinutes: Number(e.target.value) })
                    }
                  />
                </label>
              </div>
              <fieldset className="recurrence-days">
                <legend>Local weekdays</legend>
                {[
                  "Sunday",
                  "Monday",
                  "Tuesday",
                  "Wednesday",
                  "Thursday",
                  "Friday",
                  "Saturday",
                ].map((day, n) => (
                  <label key={day}>
                    <input
                      type="checkbox"
                      checked={fields.weekdays.includes(n)}
                      onChange={(e) =>
                        change({
                          weekdays: e.target.checked
                            ? [...fields.weekdays, n]
                            : fields.weekdays.filter((v) => v !== n),
                          offsets: {},
                        })
                      }
                    />
                    {day}
                  </label>
                ))}
              </fieldset>
              <label>
                Excluded dates, separated by commas
                <input
                  value={fields.exclusions.join(",")}
                  onChange={(e) =>
                    change({
                      exclusions: e.target.value
                        ? e.target.value.split(",").map((d) => d.trim())
                        : [],
                      offsets: {},
                    })
                  }
                  placeholder="2035-11-11,2035-11-18"
                />
              </label>
              <div className="form-grid">
                <label>
                  Facility ID (optional)
                  <input
                    value={fields.facilityId || ""}
                    onChange={(e) =>
                      change({ facilityId: e.target.value || null })
                    }
                  />
                </label>
                <label>
                  Field or court resource ID (optional)
                  <input
                    value={fields.resourceId || ""}
                    onChange={(e) =>
                      change({ resourceId: e.target.value || null })
                    }
                  />
                </label>
              </div>
              <p className="small muted">
                At most 16 weeks and 64 occurrences. The range must fit the
                team's season. Duration is elapsed minutes, including clock
                changes.
              </p>
              <button type="button" onClick={() => void read(false)}>
                Preview finite range
              </button>
            </section>
            {preview && (
              <section className="panel">
                <h2>Review {preview.occurrences.length} occurrences</h2>
                <p>
                  {formatCalendarDate(fields.startsOn)} through{" "}
                  {formatCalendarDate(fields.endsOn)} · {fields.timeZone} ·{" "}
                  {fields.exclusions.length} explicit exclusions
                </p>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Local date and time</th>
                        <th>UTC start</th>
                        <th>Correction</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.occurrences.map((o) => (
                        <tr key={o.id}>
                          <td>
                            {formatCalendarDate(o.localDate)} at{" "}
                            {formatClockTime(o.localTime)}
                          </td>
                          <td>
                            {o.startsAt
                              ? formatDateTime(o.startsAt, "UTC")
                              : "Unresolved"}
                          </td>
                          <td>
                            {o.issue && <p className="error">{o.issue}</p>}
                            {o.choices.length > 1 && (
                              <label>
                                UTC offset for {formatCalendarDate(o.localDate)}
                                <select
                                  aria-label={`UTC offset for ${formatCalendarDate(o.localDate)}`}
                                  value={fields.offsets[o.localDate] ?? ""}
                                  onChange={(e) =>
                                    change({
                                      offsets: {
                                        ...fields.offsets,
                                        [o.localDate]: Number(e.target.value),
                                      },
                                    })
                                  }
                                >
                                  <option value="" disabled>
                                    Choose offset
                                  </option>
                                  {o.choices.map((c) => (
                                    <option
                                      key={formatDateTime(c.startsAt, "UTC")}
                                      value={c.offsetMinutes}
                                    >
                                      UTC{c.offsetMinutes >= 0 ? "+" : "−"}
                                      {Math.abs(c.offsetMinutes) / 60} ·{" "}
                                      {formatDateTime(c.startsAt, "UTC")}
                                    </option>
                                  ))}
                                </select>
                              </label>
                            )}
                            {preview.diagnostics
                              .filter((d) => d.occurrenceId === o.id)
                              .map((d) => (
                                <p className="error" key={d.message}>
                                  {d.message}
                                </p>
                              ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!preview.occurrences.some((o) => o.issue) && (
                  <label className="recurrence-confirmation">
                    <input
                      type="checkbox"
                      checked={reviewed}
                      onChange={(e) => setReviewed(e.target.checked)}
                    />
                    I reviewed this finite range, exclusions, UTC instants and
                    any resource conflicts.
                  </label>
                )}
              </section>
            )}
          </fieldset>
          {(retry ||
            (preview &&
              reviewed &&
              !preview.occurrences.some((o) => o.issue))) && (
            <button
              className="primary"
              disabled={busy}
              onClick={() => void save()}
            >
              {busy
                ? "Saving…"
                : retry
                  ? "Retry same action"
                  : "Save reviewed draft"}
            </button>
          )}
          {busy && <p role="status">Checking current records…</p>}
        </>
      )}
    </main>
  );
}
