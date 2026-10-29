import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminEntity } from "../../shared/admin";
import type { Facility } from "../../shared/facilities";
import {
  formatMinutes,
  formatRate,
  REPORT_FORMULAS,
  REPORT_STATE_LABELS,
  reportStatusNote,
  type AttendanceCounts,
  type FacilityCounts,
  type ReportFilters,
  type ReportRow,
  type ReportRun,
} from "../../shared/reports";
import type { BrowserServices } from "./firebase";
import { errorCode, message } from "./errors";

const REFRESH_MS = 2000;
const REFRESH_LIMIT = 30;
const STALE_REASONS: Record<string, string> = {
  attendanceCorrected: "an attendance record was corrected",
  eventChanged: "an event in this range changed",
  closureChanged: "a closure changed",
  availabilityChanged: "resource availability changed",
  sourceChanged: "a rebuild found different source records",
  sourceChangedDuringBuild: "sources changed while it was calculating",
};

async function allPages<T>(fetch: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>) {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetch(cursor);
    items.push(...page.items);
    cursor = page.nextCursor || undefined;
  } while (cursor);
  return items;
}

function isoDay(offsetDays: number) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

function describe(run: ReportRun, names: Map<string, string>) {
  const f = run.filters;
  const range = `${f.fromDate} to ${f.toDate}`;
  if (f.kind === "facility") return `Facility bookings, ${names.get(f.facilityId) ?? "facility"}, ${range}`;
  return `Attendance, ${f.teamId ? names.get(f.teamId) ?? "one team" : "all teams"}, ${range}`;
}

function AttendanceTable({ rows, summary }: { rows: Extract<ReportRow, { kind: "team" }>[]; summary: AttendanceCounts }) {
  const line = (label: string, row: AttendanceCounts, key: string) => (
    <tr key={key}>
      <th scope="row">{label}</th>
      <td>{formatRate(row.presenceRate)}<br /><span className="muted">{row.presenceRate.numerator} of {row.presenceRate.denominator}</span></td>
      <td>{formatRate(row.completionCoverage)}<br /><span className="muted">{row.completionCoverage.numerator} of {row.completionCoverage.denominator}</span></td>
      <td>{row.eligible}</td><td>{row.present}</td><td>{row.late}</td><td>{row.absent}</td><td>{row.excused}</td><td>{row.unknown}</td><td>{row.missing}</td>
      <td>{row.events.closed} closed, {row.events.cancelled + row.events.postponed} excluded, {row.events.awaitingClosure} awaiting closure</td>
    </tr>
  );
  return (
    <div className="table-scroll" tabIndex={0}>
      <table>
        <caption className="sr-only">Attendance by team with numerators and denominators</caption>
        <thead>
          <tr>
            <th scope="col">Scope</th><th scope="col">Presence rate</th><th scope="col">Completion coverage</th><th scope="col">Eligible</th>
            <th scope="col">Present</th><th scope="col">Late</th><th scope="col">Absent</th><th scope="col">Excused</th><th scope="col">Unknown</th>
            <th scope="col">Missing</th><th scope="col">Events</th>
          </tr>
        </thead>
        <tbody>
          {line("All in scope", summary, "summary")}
          {rows.map((row) => line(row.label, row, row.teamId))}
        </tbody>
      </table>
    </div>
  );
}

function FacilityTable({ rows, summary }: { rows: Extract<ReportRow, { kind: "resource" }>[]; summary: FacilityCounts }) {
  const line = (label: string, row: FacilityCounts, key: string) => (
    <tr key={key}>
      <th scope="row">{label}</th>
      <td>{formatRate(row.utilization)}</td>
      <td>{formatMinutes(row.bookedMinutes)}</td><td>{formatMinutes(row.availableMinutes)}</td><td>{formatMinutes(row.closedMinutes)}</td>
      <td>{formatMinutes(row.outsideAvailabilityMinutes)}</td><td>{formatMinutes(row.conflictMinutes)}</td>
      <td>{row.unknownAvailabilityMinutes ? `${formatMinutes(row.unknownAvailabilityMinutes)} (${formatMinutes(row.unknownAvailabilityBookedMinutes)} booked)` : "None"}</td>
      <td>{row.bookings} counted, {row.excludedBookings} cancelled or postponed, {row.closureAffectedBookings} in closures</td>
    </tr>
  );
  return (
    <div className="table-scroll" tabIndex={0}>
      <table>
        <caption className="sr-only">Booked utilization by resource</caption>
        <thead>
          <tr>
            <th scope="col">Resource</th><th scope="col">Booked utilization</th><th scope="col">Booked</th><th scope="col">Bookable</th>
            <th scope="col">Closed</th><th scope="col">Booked outside availability</th><th scope="col">Overlapping</th>
            <th scope="col">Unknown availability</th><th scope="col">Reservations</th>
          </tr>
        </thead>
        <tbody>
          {line("All resources", summary, "summary")}
          {rows.map((row) => line(row.label, row, row.resourceId))}
        </tbody>
      </table>
    </div>
  );
}

function RunDetail({ services, orgId, runId, names, onRebuilt, onChanged }: { services: BrowserServices; orgId: string; runId: string; names: Map<string, string>; onRebuilt: (runId: string) => void; onChanged: () => void }) {
  const [run, setRun] = useState<ReportRun | null>(null);
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const refreshes = useRef(0);
  const rebuildId = useRef<string | null>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const shown = useRef("");

  const load = useCallback(async (cursor: string | null = null) => {
    const seq = ++request.current;
    setError("");
    try {
      const value = await services.call("getReportRun", { orgId, runId, cursor });
      // A slower earlier response never replaces a newer one.
      if (seq !== request.current) return;
      setRun(value.run);
      setRows((current) => (cursor ? [...current, ...value.rows] : value.rows));
      setNextCursor(value.nextCursor);
    } catch (reason) {
      if (seq === request.current) setError(message(reason));
    }
  }, [services, orgId, runId]);

  useEffect(() => {
    refreshes.current = 0;
    rebuildId.current = null;
    setRun(null);
    setRows([]);
    void load();
  }, [load]);

  useEffect(() => {
    if (!run || (run.state !== "queued" && run.state !== "building") || refreshes.current >= REFRESH_LIMIT) return;
    const timer = setTimeout(() => {
      refreshes.current += 1;
      void load();
    }, REFRESH_MS);
    return () => clearTimeout(timer);
  }, [run, load]);

  // Keep the run list in step when this run finishes or turns stale.
  useEffect(() => {
    if (!run) return;
    const key = `${run.state}:${run.stale}`;
    if (shown.current && shown.current !== key) changed.current();
    shown.current = key;
  }, [run]);

  const rebuild = async () => {
    setBusy(true);
    setError("");
    // Reuse the request ID until the rebuild is confirmed, so a retry after an uncertain failure cannot queue twice.
    rebuildId.current ??= crypto.randomUUID();
    try {
      const value = await services.call("rebuildReport", { requestId: rebuildId.current, orgId, runId });
      rebuildId.current = null;
      onRebuilt(value.runId);
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  if (!run) return <section className="panel" aria-busy="true"><h2>Report</h2>{error ? <p className="error" role="alert">{error}</p> : <p className="muted">Loading report.</p>}</section>;
  const note = reportStatusNote(run);
  const tz = run.interval.timeZone;
  return (
    <section className="panel report-detail" aria-label="Report detail">
      <h2>{describe(run, names)}</h2>
      <p className={run.state === "failed" || run.stale ? "error" : run.state === "complete" ? "muted" : "notice"} role="status">
        {REPORT_STATE_LABELS[run.state]}{run.stale ? ", stale" : ""}. {note ?? `Calculated ${new Date(run.completedAt!).toLocaleString()} from records read at ${new Date(run.sourceCutoff!).toLocaleString()}.`}
        {run.stale && run.staleReason ? ` Marked stale because ${STALE_REASONS[run.staleReason] ?? "sources changed"}.` : ""}
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      <p className="muted">
        Local dates in {tz}: {new Date(run.interval.startsAt).toLocaleString("en-US", { timeZone: tz })} to {new Date(run.interval.endsAt).toLocaleString("en-US", { timeZone: tz })} ({run.interval.hours} hours). Report version {run.reportVersion}, formula version {run.reducerVersion}.
        {run.supersedes ? " Rebuilt from an earlier run." : ""}{run.supersededBy ? " A newer rebuild exists." : ""}
      </p>
      {run.state === "complete" && run.summary && (run.filters.kind === "attendance"
        ? <AttendanceTable summary={run.summary as AttendanceCounts} rows={rows as Extract<ReportRow, { kind: "team" }>[]} />
        : <FacilityTable summary={run.summary as FacilityCounts} rows={rows as Extract<ReportRow, { kind: "resource" }>[]} />)}
      {run.state === "complete" && run.manifest && (
        <p className="muted">Source records read: {Object.entries(run.manifest).filter(([key]) => key.endsWith("Reads")).reduce((sum, [, value]) => sum + value, 0)}. Source fingerprint {run.sourceDigest?.slice(0, 12)}.</p>
      )}
      <details>
        <summary>How these figures are calculated</summary>
        <ul>{REPORT_FORMULAS[run.kind].map((line) => <li key={line}>{line}</li>)}</ul>
      </details>
      <div className="actions">
        {nextCursor && <button type="button" onClick={() => void load(nextCursor)}>More rows</button>}
        <button type="button" onClick={() => { refreshes.current = 0; void load(); }}>Refresh</button>
        {(run.state === "complete" || run.state === "failed") && <button type="button" className="primary" disabled={busy} onClick={() => void rebuild()}>Rebuild from current records</button>}
      </div>
    </section>
  );
}

/** Organization report runs. Every figure comes from an immutable snapshot; corrections mark it stale instead of editing it. */
export function Reports({ services, orgId, programId: initialProgram }: { services: BrowserServices; orgId: string; programId: string }) {
  const [programs, setPrograms] = useState<AdminEntity[]>([]);
  const [programId, setProgramId] = useState(initialProgram);
  const [seasons, setSeasons] = useState<AdminEntity[]>([]);
  const [teams, setTeams] = useState<AdminEntity[]>([]);
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [kind, setKind] = useState<"attendance" | "facility">("attendance");
  const [seasonId, setSeasonId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [facilityId, setFacilityId] = useState("");
  const [fromDate, setFromDate] = useState(isoDay(-30));
  const [toDate, setToDate] = useState(isoDay(0));
  const [runs, setRuns] = useState<ReportRun[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const pending = useRef<{ key: string; requestId: string } | null>(null);
  const listRequest = useRef(0);

  useEffect(() => {
    allPages((cursor) => services.call("listOrganizationHierarchy", { orgId, kind: "program", ...(cursor ? { cursor } : {}) })).then(setPrograms).catch((reason) => setError(message(reason)));
    services.call("listFacilities", { orgId }).then((page) => setFacilities(page.items)).catch(() => setFacilities([]));
  }, [orgId, services]);

  useEffect(() => {
    setSeasons([]);
    setTeams([]);
    setSeasonId("");
    setTeamId("");
    if (!programId) return;
    let current = true;
    const list = (kind: "season" | "team") => allPages((cursor) => services.call("listOrganizationHierarchy", { orgId, kind, programId, ...(cursor ? { cursor } : {}) }));
    Promise.all([list("season"), list("team")]).then(([s, t]) => {
      if (!current) return;
      setSeasons(s);
      setTeams(t);
      setSeasonId(s[0]?.id ?? "");
    }).catch((reason) => current && setError(message(reason)));
    return () => { current = false; };
  }, [orgId, programId, services]);

  const loadRuns = useCallback(async () => {
    const seq = ++listRequest.current;
    try {
      const page = await services.call("listReportRuns", { orgId, programId: kind === "facility" ? null : programId || null });
      if (seq === listRequest.current) setRuns(page.items);
    } catch (reason) {
      if (seq !== listRequest.current) return;
      setRuns([]);
      // Program staff list runs one held program at a time; only administrators list everything.
      if (!(errorCode(reason).includes("permission-denied") && !programId)) setError(message(reason));
    }
  }, [services, orgId, programId, kind]);

  useEffect(() => { void loadRuns(); }, [loadRuns]);

  const filters = (): ReportFilters => kind === "facility"
    ? { kind, facilityId, fromDate, toDate }
    : { kind, programId, seasonId, teamId: teamId || null, fromDate, toDate };
  const submit = async () => {
    setSubmitting(true);
    setError("");
    const value = filters();
    const key = JSON.stringify(value);
    // An uncertain failure retries with the same request ID; changed filters start a new request.
    if (pending.current?.key !== key) pending.current = { key, requestId: crypto.randomUUID() };
    try {
      const result = await services.call("requestReport", { requestId: pending.current.requestId, orgId, filters: value });
      pending.current = null;
      setSelected(result.runId);
      await loadRuns();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setSubmitting(false);
    }
  };

  const names = new Map<string, string>([...teams.map((team) => [team.id, team.name] as const), ...facilities.map((facility) => [facility.id, facility.name] as const)]);
  const ready = kind === "facility" ? !!facilityId : !!programId && !!seasonId;
  return (
    <div className="page reports">
      <h1>Reports</h1>
      <p className="muted">Attendance and booked-facility snapshots with visible numerators, denominators and missing data. Booked time is reservations, not actual use.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <section className="panel">
        <h2>New report</h2>
        <form className="toolbar report-form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <label>
            Report
            <select value={kind} onChange={(e) => setKind(e.target.value as "attendance" | "facility")}>
              <option value="attendance">Attendance</option>
              <option value="facility">Facility booked time</option>
            </select>
          </label>
          {kind === "attendance" ? (
            <>
              <label>
                Program
                <select value={programId} onChange={(e) => setProgramId(e.target.value)}>
                  <option value="">Choose a program</option>
                  {programs.map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}
                </select>
              </label>
              <label>
                Season
                <select value={seasonId} onChange={(e) => setSeasonId(e.target.value)} disabled={!seasons.length}>
                  {seasons.map((season) => <option key={season.id} value={season.id}>{season.name}</option>)}
                </select>
              </label>
              <label>
                Team
                <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                  <option value="">All teams</option>
                  {teams.filter((team) => !seasonId || team.seasonId === seasonId).map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
                </select>
              </label>
            </>
          ) : (
            <label>
              Facility
              <select value={facilityId} onChange={(e) => setFacilityId(e.target.value)}>
                <option value="">Choose a facility</option>
                {facilities.map((facility) => <option key={facility.id} value={facility.id}>{facility.name}</option>)}
              </select>
            </label>
          )}
          <label>From<input type="date" required value={fromDate} onChange={(e) => setFromDate(e.target.value)} /></label>
          <label>To<input type="date" required value={toDate} onChange={(e) => setToDate(e.target.value)} /></label>
          <button className="primary" type="submit" disabled={!ready || submitting}>{submitting ? "Requesting" : "Run report"}</button>
        </form>
        <p className="muted">Dates are local to the organization time zone and include both ends. At most 366 days per run.</p>
      </section>
      <section className="panel">
        <h2>Recent runs</h2>
        {!runs.length ? <p className="muted">No reports yet for this selection.</p> : (
          <ul className="report-runs">
            {runs.map((run) => (
              <li key={run.runId}>
                <button type="button" aria-pressed={selected === run.runId} onClick={() => setSelected(run.runId)}>
                  {describe(run, names)}: {REPORT_STATE_LABELS[run.state]}{run.stale ? ", stale" : ""}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="actions"><button type="button" onClick={() => void loadRuns()}>Refresh list</button></div>
      </section>
      {selected && <RunDetail key={selected} services={services} orgId={orgId} runId={selected} names={names} onRebuilt={(runId) => { setSelected(runId); void loadRuns(); }} onChanged={() => void loadRuns()} />}
    </div>
  );
}
