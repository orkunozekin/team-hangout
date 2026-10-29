import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  bracketNodeStatus,
  roundLabel,
  RESULT_REASON_MAX,
  type BracketCorrectionPreview,
  type BracketNodeView,
  type BracketPreview,
  type BracketView,
  type CompetitionDetail,
  type CompetitionSummary,
} from "../../shared/competition";
import type { BrowserServices } from "./firebase";
import { errorCode, message } from "./errors";
import { Mutation } from "./Mutation";

type Names = (teamId: string) => string;

function Rounds({ nodes, rounds, names, children }: { nodes: BracketNodeView[]; rounds: number; names: Names; children?: (node: BracketNodeView) => ReactNode }) {
  return (
    <div className="bracket">
      {Array.from({ length: rounds }, (_, i) => i + 1).map((round) => (
        <section key={round} className="bracket-round" aria-label={roundLabel(round, rounds)}>
          <h3>{roundLabel(round, rounds)}</h3>
          <ol>
            {nodes.filter((node) => node.round === round).map((node) => (
              <li key={node.nodeId} aria-label={`${roundLabel(round, rounds)} game ${node.index + 1}`} className={`bracket-node ${node.state}${node.winnerPending ? " pending" : ""}`}>
                <ul className="bracket-teams">
                  {node.teams.map((team, slot) => (
                    <li key={slot} className={team && node.winnerTeamId === team.teamId && !node.bye ? "winner" : undefined}>
                      {team ? <>{team.seed !== null && <span className="seed">{team.seed}</span>} {team.name}</> : <span className="muted">{node.bye ? "Bye" : "To be decided"}</span>}
                    </li>
                  ))}
                </ul>
                <p className="bracket-status">{bracketNodeStatus(node, names)}</p>
                {children?.(node)}
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

function LinkMatch({ services, orgId, detail, view, node, names, onDenied, onSaved }: {
  services: BrowserServices; orgId: string; detail: CompetitionDetail; view: BracketView; node: BracketNodeView; names: Names; onDenied: () => void; onSaved: () => void;
}) {
  const teamIds = node.teams.map((team) => team?.teamId);
  const candidates = detail.matches.filter((row) => row.eventId !== node.eventId && row.status !== "cancelled"
    && teamIds.includes(row.homeTeamId) && teamIds.includes(row.awayTeamId));
  const [eventId, setEventId] = useState("");
  if (!candidates.length) return node.eventId ? null : <p className="muted">No match between these teams on the loaded results page.</p>;
  return (
    <Mutation
      label={node.eventId ? "Replace match" : "Link match"}
      onDenied={onDenied}
      onSaved={onSaved}
      action={() => {
        const requestId = crypto.randomUUID();
        const payload = { nodeId: node.nodeId, eventId };
        return () => services.call("linkBracketEvent", { requestId, orgId, resourceId: view.competitionId, expectedRevision: view.bracketRevision, payload });
      }}
    >
      <label>
        Canonical match
        <select required value={eventId} onChange={(e) => setEventId(e.target.value)}>
          <option value="">Choose a match</option>
          {candidates.map((row) => (
            <option key={row.eventId} value={row.eventId}>
              {`${names(row.homeTeamId)} vs ${names(row.awayTeamId)}, ${row.startsAt ? new Date(row.startsAt).toLocaleString() : "unscheduled"}`}
            </option>
          ))}
        </select>
      </label>
    </Mutation>
  );
}

/** Seeds, byes and publication for a knockout competition, then canonical match links per game. */
export function Bracket({ services, orgId, detail, sources, onDenied, onChanged }: {
  services: BrowserServices; orgId: string; detail: CompetitionDetail; sources: CompetitionSummary[]; onDenied: () => void; onChanged: (notice: string) => void;
}) {
  const competitionId = detail.competition.competitionId;
  const names: Names = (teamId) => detail.teams.find((team) => team.teamId === teamId)?.name ?? "Unavailable team";
  const [view, setView] = useState<BracketView | null>(null);
  const [error, setError] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [override, setOverride] = useState(false);
  const [order, setOrder] = useState<string[]>(detail.competition.teamIds);
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<{ key: string; value: BracketPreview } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // Only the latest request may update the panel, so a slow response cannot replace a newer one.
  const loadSeq = useRef(0);
  const previewSeq = useRef(0);

  const fail = useCallback((reason: unknown) => {
    if (errorCode(reason).includes("permission-denied")) onDenied();
    else setError(message(reason));
  }, [onDenied]);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const value = await services.call("getBracket", { orgId, competitionId });
      if (seq === loadSeq.current) {
        setView(value);
        setError("");
      }
    } catch (reason) {
      if (seq === loadSeq.current) fail(reason);
    }
  }, [services, orgId, competitionId, fail]);

  useEffect(() => { void load(); }, [load]);

  const manual = !sourceId || override;
  const inputs = { sourceCompetitionId: sourceId || null, seedOverride: manual ? { teamIds: order, reason: reason.trim() } : null };
  const key = JSON.stringify(inputs);
  // A preview is shown only for the inputs it was computed from; changing any input requires a new preview.
  const current = preview?.key === key ? preview.value : null;

  const runPreview = async () => {
    const seq = ++previewSeq.current;
    setPreviewing(true);
    setError("");
    try {
      const value = await services.call("previewBracket", { orgId, competitionId, ...inputs });
      if (seq === previewSeq.current) setPreview({ key, value });
    } catch (reason) {
      if (seq === previewSeq.current) {
        setPreview(null);
        fail(reason);
      }
    } finally {
      if (seq === previewSeq.current) setPreviewing(false);
    }
  };

  const move = (index: number, delta: number) => {
    const next = [...order];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    setOrder(next);
  };
  const changed = (text: string) => {
    setPreview(null);
    void load();
    onChanged(text);
  };
  const locked = view?.nodes.some((node) => !node.bye && (node.eventId || node.winnerTeamId || node.voidedPlays.length > 0)) ?? false;
  const bracket = view?.bracket;

  return (
    <section className="panel" aria-label="Bracket">
      <h2>Bracket</h2>
      {error && <p className="error" role="alert">{error}</p>}
      {bracket && view && (
        <>
          <p className="muted">
            {`${bracket.teamCount} teams, ${bracket.size}-slot bracket, published ${new Date(bracket.publishedAt).toLocaleString()}. `}
            {bracket.override ? `Seeds set by a manager: ${bracket.override.reason.replace(/[.!?]$/, "")}.` : bracket.source ? `Seeded from ${bracket.source.name} standings.` : ""}
            {" Winners advance only from final results. Byes have no match, attendance or booking."}
          </p>
          <Rounds nodes={view.nodes} rounds={bracket.rounds} names={names}>
            {(node) => (node.state === "ready" || node.state === "scheduled") && (
              <LinkMatch services={services} orgId={orgId} detail={detail} view={view} node={node} names={names} onDenied={onDenied} onSaved={() => changed("Match linked to the bracket game.")} />
            )}
          </Rounds>
        </>
      )}
      {view && !locked && (
        <details open={!bracket}>
          <summary>{bracket ? "Replace the bracket before any game is linked" : "Preview and publish"}</summary>
          <div className="form-grid">
            <label>
              Seed from
              <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                <option value="">Manual seed order</option>
                {sources.map((item) => <option key={item.competitionId} value={item.competitionId}>{`${item.name} standings`}</option>)}
              </select>
            </label>
            {sourceId && (
              <label className="toggle">
                <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
                Record a seed override
              </label>
            )}
          </div>
          {manual && (
            <fieldset>
              <legend>Seed order</legend>
              <ol className="seed-order">
                {order.map((teamId, index) => (
                  <li key={teamId}>
                    {names(teamId)}{" "}
                    <button type="button" aria-label={`Move ${names(teamId)} up`} disabled={index === 0} onClick={() => move(index, -1)}>Up</button>{" "}
                    <button type="button" aria-label={`Move ${names(teamId)} down`} disabled={index === order.length - 1} onClick={() => move(index, 1)}>Down</button>
                  </li>
                ))}
              </ol>
              <label>
                Reason for this order
                <textarea required maxLength={RESULT_REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
            </fieldset>
          )}
          <div className="actions">
            <button type="button" disabled={previewing || (manual && !reason.trim())} onClick={() => void runPreview()}>Preview bracket</button>
          </div>
          {current && (
            <>
              {current.blocked === "SEED_TIE_UNRESOLVED" && (
                <p className="error" role="alert">
                  {`Unresolved standings tie: ${current.unresolvedTies.map((group) => group.map((team) => team.name).join(" and ")).join("; ")}. Record a seed override with a reason before publishing.`}
                </p>
              )}
              {current.blocked === "SEED_ORDER_REQUIRED" && <p className="error" role="alert">Choose a standings source or record a seed order with a reason.</p>}
              {current.nodes.length > 0 && <Rounds nodes={current.nodes} rounds={Math.max(...current.nodes.map((node) => node.round))} names={names} />}
              {!current.blocked && (
                <Mutation
                  label={bracket ? "Replace bracket" : "Publish bracket"}
                  onDenied={onDenied}
                  onSaved={() => changed("Bracket published.")}
                  action={() => {
                    const requestId = crypto.randomUUID();
                    const payload = {
                      ...inputs, generationId: current.source?.generationId ?? null, sourceRevision: current.source?.sourceRevision ?? null, previewHash: current.previewHash,
                    };
                    return () => services.call("publishBracket", { requestId, orgId, resourceId: competitionId, expectedRevision: current.bracketRevision, payload });
                  }}
                />
              )}
            </>
          )}
        </details>
      )}
    </section>
  );
}

/** Lists the bracket games a corrected winner affects. Started games need explicit confirmation before they are invalidated. */
export function BracketImpact({ impact, names }: { impact: BracketCorrectionPreview; names: Names }) {
  if (!impact.nodeId) return <p className="muted">This match is not linked to the bracket.</p>;
  if (impact.previousWinnerTeamId === impact.winnerTeamId) return <p className="muted">The winner does not change, so the bracket is unaffected.</p>;
  const winner = (teamId: string | null) => (teamId ? names(teamId) : "no winner");
  return (
    <div className={impact.requiresConfirmation ? "error" : "notice"} role="status">
      <p>{`The winner changes from ${winner(impact.previousWinnerTeamId)} to ${winner(impact.winnerTeamId)}.`}</p>
      {impact.affected.length === 0 ? <p>No later game is affected.</p> : (
        <ul>
          {impact.affected.map((row) => (
            <li key={row.nodeId}>
              {`${roundLabel(row.round, impact.rounds)} game ${row.index + 1}: `}
              {row.started
                ? `already started${row.winnerTeamId ? ` (${names(row.winnerTeamId)} advanced)` : ""}. It will be invalidated and needs a new match; its played result stays in history.`
                : `not started. Its participant${row.eventId ? " and match link" : ""} will be cleared.`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
