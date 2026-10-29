import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatDifferential,
  STANDINGS_STATUS_LABELS,
  TIE_BREAKER_LABELS,
  tieNote,
  type StandingsView,
} from "../../shared/competition";
import type { BrowserServices } from "./firebase";
import { errorCode, message } from "./errors";

const REFRESH_MS = 3000;
const REFRESH_LIMIT = 20;

/** Shows only one complete generation at a time. Pages stay pinned to the generation of the first page. */
export function Standings({ services, orgId, competitionId, onDenied }: { services: BrowserServices; orgId: string; competitionId: string; onDenied: (reason: unknown) => void }) {
  const [view, setView] = useState<StandingsView | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const refreshes = useRef(0);
  // Only the latest request may replace the shown table, so a slow page cannot overwrite a newer refresh.
  const request = useRef(0);
  // The parent passes a new handler each render; keep it out of the load dependencies so loading runs once per key.
  const denied = useRef(onDenied);
  denied.current = onDenied;

  const load = useCallback(async (page: { generationId: string; cursor: string } | null = null) => {
    const seq = ++request.current;
    setLoading(true);
    setError("");
    try {
      const value = await services.call("getStandings", { orgId, competitionId, ...(page ?? {}) });
      if (seq !== request.current) return;
      setView(value);
      setCursor(page?.cursor ?? null);
    } catch (reason) {
      if (seq !== request.current) return;
      if (errorCode(reason).includes("permission-denied")) denied.current(reason);
      else if (page && (reason as { details?: { domainCode?: string } }).details?.domainCode === "STANDINGS_CHANGED") {
        setNotice("Standings were updated while paging. Showing the latest table from the top.");
        setCursor(null);
        await load();
        return;
      } else setError(message(reason));
    } finally {
      if (seq === request.current) setLoading(false);
    }
  }, [services, orgId, competitionId]);

  useEffect(() => {
    refreshes.current = 0;
    void load();
  }, [load]);

  // While a rebuild is pending, re-read the first page a bounded number of times. Paging stays on its pinned table.
  useEffect(() => {
    if (!view || cursor || (view.status !== "updating" && view.status !== "stale") || refreshes.current >= REFRESH_LIMIT) return;
    const timer = setTimeout(() => {
      refreshes.current += 1;
      void load();
    }, REFRESH_MS);
    return () => clearTimeout(timer);
  }, [view, cursor, load]);

  const names = (teamId: string) => view?.rows.find((row) => row.teamId === teamId)?.teamName ?? "another team";
  const generation = view?.generation;
  return (
    <section className="panel standings" aria-label="Standings" aria-busy={loading}>
      <h2>Standings</h2>
      {notice && <p className="notice" role="status">{notice}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {view && (
        <p className={view.status === "current" ? "muted" : view.status === "stale" ? "error" : "notice"} role="status">
          {STANDINGS_STATUS_LABELS[view.status]}
          {(view.status === "updating" || view.status === "stale") && view.sourceUpdatedAt ? ` Latest result change ${new Date(view.sourceUpdatedAt).toLocaleString()}.` : ""}
        </p>
      )}
      {generation && (
        <p className="muted">
          Generation from {generation.countedResults} counted results, rules version {generation.rulesVersion}, completed {new Date(generation.completedAt).toLocaleString()}.
          {generation.unresolvedTies ? ` ${generation.unresolvedTies} unresolved ${generation.unresolvedTies === 1 ? "tie" : "ties"}; tied teams share a rank and list order is not a ranking.` : ""}
          {!generation.active ? " A newer table is available; return to the first page to see it." : ""}
        </p>
      )}
      {view && !generation && view.status !== "unconfirmed" && <p className="muted">No complete table yet.</p>}
      {generation && (
        <div className="table-scroll" tabIndex={0}>
          <table>
            <caption className="sr-only">Standings for {view!.name}</caption>
            <thead>
              <tr>
                <th scope="col">Rank</th><th scope="col">Team</th><th scope="col"><abbr title="Played">P</abbr></th>
                <th scope="col"><abbr title="Wins">W</abbr></th><th scope="col"><abbr title="Draws">D</abbr></th><th scope="col"><abbr title="Losses">L</abbr></th>
                <th scope="col"><abbr title="Scores for">SF</abbr></th><th scope="col"><abbr title="Scores against">SA</abbr></th>
                <th scope="col"><abbr title="Score differential after any cap">Diff</abbr></th><th scope="col"><abbr title="Table points">Pts</abbr></th><th scope="col">Notes</th>
              </tr>
            </thead>
            <tbody>
              {view!.rows.map((row) => {
                const notes = [
                  tieNote(row, names),
                  row.forfeitWins || row.forfeitLosses ? `Forfeits: ${row.forfeitWins} won, ${row.forfeitLosses} lost` : null,
                  row.decidedBy && row.decidedBy !== "tablePoints" ? `Placed by ${TIE_BREAKER_LABELS[row.decidedBy].toLowerCase()}` : null,
                ].filter(Boolean);
                return (
                  <tr key={row.teamId} className={row.sharedRank ? "tied" : undefined}>
                    <td>{row.sharedRank ? `T-${row.rank}` : row.rank}</td>
                    <th scope="row">{row.teamName}</th>
                    <td>{row.played}</td><td>{row.wins}</td><td>{row.draws}</td><td>{row.losses}</td>
                    <td>{row.scoresFor}</td><td>{row.scoresAgainst}</td><td>{formatDifferential(row.differential)}</td>
                    <td><strong>{row.points}</strong></td>
                    <td>{notes.join(". ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="actions">
        <button type="button" disabled={loading} onClick={() => { refreshes.current = 0; setNotice(""); void load(); }}>Refresh</button>
        {cursor && <button type="button" onClick={() => void load()}>First page</button>}
        {generation && view?.nextCursor && (
          <button type="button" disabled={loading} onClick={() => void load({ generationId: generation.generationId, cursor: view.nextCursor! })}>Next page</button>
        )}
      </div>
    </section>
  );
}
