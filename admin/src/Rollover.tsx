import { useCallback, useEffect, useRef, useState } from "react";
import type { AdminEntity } from "../../shared/admin";
import {
  notCopiedLabel,
  ROLLOVER_REASON_LABELS,
  ROLLOVER_STATE_LABELS,
  rolloverProgress,
  type RolloverInput,
  type RolloverJob,
  type RolloverPreview,
} from "../../shared/rollover";
import type { BrowserServices } from "./firebase";
import { message } from "./errors";

const REFRESH_MS = 2000;
const REFRESH_LIMIT = 30;

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

function domainCode(error: unknown) {
  const details = typeof error === "object" && error !== null && "details" in error ? (error as { details?: { domainCode?: string } }).details : null;
  return details?.domainCode ?? "";
}

export function Rollover({ services, orgId }: { services: BrowserServices; orgId: string }) {
  const [programs, setPrograms] = useState<AdminEntity[]>([]);
  const [seasons, setSeasons] = useState<AdminEntity[]>([]);
  const [programId, setProgramId] = useState("");
  const [sourceSeasonId, setSourceSeasonId] = useState("");
  const [name, setName] = useState("");
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const [excluded, setExcluded] = useState<string[]>([]);
  const [preview, setPreview] = useState<RolloverPreview | null>(null);
  const [previewKey, setPreviewKey] = useState("");
  const [jobs, setJobs] = useState<RolloverJob[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const previewSeq = useRef(0);
  const listSeq = useRef(0);
  const refreshes = useRef(0);
  const pending = useRef<{ key: string; requestId: string } | null>(null);

  useEffect(() => {
    allPages((cursor) => services.call("listOrganizationHierarchy", { orgId, kind: "program", ...(cursor ? { cursor } : {}) }))
      .then(setPrograms).catch((reason) => setError(message(reason)));
  }, [orgId, services]);

  useEffect(() => {
    setSeasons([]);
    setSourceSeasonId("");
    if (!programId) return;
    let current = true;
    allPages((cursor) => services.call("listOrganizationHierarchy", { orgId, kind: "season", programId, ...(cursor ? { cursor } : {}) }))
      .then((items) => { if (current) setSeasons(items); })
      .catch((reason) => current && setError(message(reason)));
    return () => { current = false; };
  }, [orgId, programId, services]);

  const input = (): RolloverInput => ({ orgId, sourceSeasonId, target: { name: name.trim(), startsOn, endsOn }, excludedTeamIds: [...excluded].sort() });
  const key = JSON.stringify(input());
  // A source, target or selection change makes the shown preview unusable for commit.
  const current = !!preview && previewKey === key;

  const loadJobs = useCallback(async () => {
    const seq = ++listSeq.current;
    try {
      const page = await services.call("listRolloverJobs", { orgId });
      // A slower earlier response never replaces a newer one.
      if (seq === listSeq.current) setJobs(page.items);
    } catch (reason) {
      if (seq === listSeq.current) setError(message(reason));
    }
  }, [orgId, services]);
  useEffect(() => { void loadJobs(); }, [loadJobs]);

  const active = jobs.some((job) => job.state === "queued" || job.state === "running");
  useEffect(() => {
    if (!active) {
      refreshes.current = 0;
      return;
    }
    if (refreshes.current >= REFRESH_LIMIT) return;
    const timer = setTimeout(() => {
      refreshes.current += 1;
      void loadJobs();
    }, REFRESH_MS);
    return () => clearTimeout(timer);
  }, [active, jobs, loadJobs]);

  const runPreview = async () => {
    const seq = ++previewSeq.current;
    const value = input();
    const valueKey = JSON.stringify(value);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await services.call("previewRollover", value);
      if (seq !== previewSeq.current) return;
      setPreview(result);
      setPreviewKey(valueKey);
    } catch (reason) {
      if (seq !== previewSeq.current) return;
      setPreview(null);
      setError(message(reason));
    } finally {
      if (seq === previewSeq.current) setBusy(false);
    }
  };

  const commit = async () => {
    if (!preview || !current) return;
    const commitKey = `${key}:${preview.previewHash}`;
    // An uncertain failure retries with the same request ID; a new preview starts a new request.
    if (pending.current?.key !== commitKey) pending.current = { key: commitKey, requestId: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const result = await services.call("commitRollover", { ...input(), requestId: pending.current.requestId, previewHash: preview.previewHash });
      pending.current = null;
      previewSeq.current += 1;
      setPreview(null);
      setNotice(`Rollover started for ${result.job.target.name}. The new season stays a hidden draft until every team is created.`);
      await loadJobs();
    } catch (reason) {
      if (domainCode(reason) === "ROLLOVER_PREVIEW_CHANGED") {
        pending.current = null;
        setPreview(null);
        setError("The source season changed since this preview. Preview again to review the current teams before committing.");
      } else setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const resume = async (job: RolloverJob) => {
    setError("");
    try {
      await services.call("resumeRollover", { requestId: crypto.randomUUID(), orgId, jobId: job.jobId });
      refreshes.current = 0;
      await loadJobs();
    } catch (reason) {
      setError(message(reason));
    }
  };

  const toggle = (teamId: string, include: boolean) =>
    setExcluded((items) => (include ? items.filter((id) => id !== teamId) : [...items, teamId]));
  const ready = !!sourceSeasonId && !!name.trim() && !!startsOn && !!endsOn;
  return (
    <div className="page rollover">
      <h1>Season rollover</h1>
      <p className="muted">Copy a season's divisions and teams into a new draft season. Rosters, staff, guardians, events and messages stay with the original season.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      <section className="panel">
        <h2>Preview</h2>
        <form className="toolbar report-form" onSubmit={(e) => { e.preventDefault(); void runPreview(); }}>
          <label>
            Program
            <select value={programId} onChange={(e) => { setProgramId(e.target.value); setExcluded([]); setPreview(null); }}>
              <option value="">Choose a program</option>
              {programs.map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}
            </select>
          </label>
          <label>
            Source season
            <select value={sourceSeasonId} onChange={(e) => { setSourceSeasonId(e.target.value); setExcluded([]); setPreview(null); }} disabled={!seasons.length}>
              <option value="">Choose a season</option>
              {seasons.map((season) => <option key={season.id} value={season.id}>{season.name}{season.status === "archived" ? " (archived)" : ""}</option>)}
            </select>
          </label>
          <label>New season name<input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} /></label>
          <label>Starts<input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></label>
          <label>Ends<input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} /></label>
          <button className="primary" type="submit" disabled={!ready || busy}>{busy ? "Working" : "Preview rollover"}</button>
        </form>
      </section>
      {preview && (
        <section className="panel" aria-labelledby="rollover-preview">
          <h2 id="rollover-preview">{preview.source.name} to {preview.target.name}</h2>
          <p>
            {preview.counts.teams} teams and {preview.counts.divisions} divisions will be created.{" "}
            {preview.counts.excludedTeams} teams and {preview.counts.excludedDivisions} divisions are excluded.
          </p>
          {!current && <p className="notice" role="status">The selection changed. Preview again before committing.</p>}
          <h3>Never copied</h3>
          <ul className="rollover-excluded">{preview.notCopied.map((kind) => <li key={kind}>{notCopiedLabel(kind)}</li>)}</ul>
          <div className="table-scroll" tabIndex={0}>
            <table>
              <caption className="sr-only">Source teams and whether each is copied</caption>
              <thead><tr><th scope="col">Copy</th><th scope="col">Team</th><th scope="col">Division</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {preview.teams.map((team) => {
                  const selectable = team.included || team.reason === "deselected";
                  const checked = selectable && !excluded.includes(team.id);
                  return (
                    <tr key={team.id}>
                      <td>
                        <input type="checkbox" aria-label={`Copy ${team.name}`} checked={checked} disabled={!selectable || busy}
                          onChange={(e) => toggle(team.id, e.target.checked)} />
                      </td>
                      <th scope="row">{team.name}</th>
                      <td>{preview.divisions.find((division) => division.id === team.divisionId)?.name ?? "None"}</td>
                      <td>{team.reason ? ROLLOVER_REASON_LABELS[team.reason] : "Copied as a new team"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="actions">
            <button className="primary" type="button" disabled={!current || busy || !preview.counts.teams} onClick={() => void commit()}>
              Create draft season
            </button>
          </div>
        </section>
      )}
      <section className="panel">
        <h2>Rollover jobs</h2>
        {!jobs.length ? <p className="muted">No rollovers yet.</p> : (
          <ul className="report-runs">
            {jobs.map((job) => (
              <li key={job.jobId} className="rollover-job">
                <p><strong>{job.target.name}</strong>: {ROLLOVER_STATE_LABELS[job.state]}. {rolloverProgress(job)}.</p>
                {job.failure && <p className="rollover-failure">{job.failure.message}</p>}
                {job.state === "failed" && <button type="button" onClick={() => void resume(job)}>Resume from checkpoint</button>}
              </li>
            ))}
          </ul>
        )}
        <div className="actions"><button type="button" onClick={() => void loadJobs()}>Refresh list</button></div>
      </section>
    </div>
  );
}
