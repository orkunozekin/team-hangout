import { useCallback, useEffect, useState } from "react";
import type { AdminEntity } from "../../shared/admin";
import {
  DECIDER_LABELS,
  describeResult,
  draftRulesTemplate,
  KNOCKOUT_DECIDERS_ALL,
  RESULT_REASON_MAX,
  TIE_BREAKER_LABELS,
  type CompetitionDetail,
  type CompetitionFormat,
  type CompetitionRules,
  type CompetitionSummary,
  type KnockoutDecider,
  type ResultOutcome,
  type ResultValues,
  type TieBreaker,
} from "../../shared/competition";
import type { BrowserServices } from "./firebase";
import { errorCode, message } from "./errors";
import { Mutation } from "./Mutation";

type Match = CompetitionDetail["matches"][number];
type ProgramData = { programId: string; seasons: AdminEntity[]; divisions: AdminEntity[]; teams: AdminEntity[] };
type Setup = { competitionId: string; revision: number; name: string; seasonId: string; divisionId: string; format: CompetitionFormat; teamIds: string[]; rules: CompetitionRules; locked: boolean };

const TIE_BREAKERS = Object.keys(TIE_BREAKER_LABELS) as TieBreaker[];

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

function NumberField({ label, value, onChange, min = 0, max = 100 }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number }) {
  return (
    <label>
      {label}
      <input type="number" min={min} max={max} step={1} required value={value} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  );
}

function RulesEditor({ rules, format, onChange }: { rules: CompetitionRules; format: CompetitionFormat; onChange: (rules: CompetitionRules) => void }) {
  const set = (patch: Partial<CompetitionRules>) => onChange({ ...rules, ...patch });
  const points = (key: keyof CompetitionRules["points"], value: number) => set({ points: { ...rules.points, [key]: value } });
  const toggle = <T,>(items: T[], item: T, on: boolean) => (on ? [...items, item] : items.filter((value) => value !== item));
  const move = (index: number, delta: number) => {
    const next = [...rules.tieBreakers];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    set({ tieBreakers: next });
  };
  return (
    <>
      <fieldset className="form-grid">
        <legend>Table points</legend>
        <NumberField label="Win" value={rules.points.win} onChange={(v) => points("win", v)} />
        <NumberField label="Draw" value={rules.points.draw} onChange={(v) => points("draw", v)} />
        <NumberField label="Loss" value={rules.points.loss} onChange={(v) => points("loss", v)} />
        <NumberField label="Forfeit win" value={rules.points.forfeitWin} onChange={(v) => points("forfeitWin", v)} />
        <NumberField label="Forfeit loss" value={rules.points.forfeitLoss} onChange={(v) => points("forfeitLoss", v)} />
      </fieldset>
      <fieldset className="form-grid">
        <legend>Outcomes</legend>
        <label className="toggle">
          <input type="checkbox" checked={rules.allowDraws} disabled={format === "knockout"} onChange={(e) => set({ allowDraws: e.target.checked, points: { ...rules.points, draw: e.target.checked ? rules.points.draw : 0 } })} />
          League draws allowed
        </label>
        <NumberField label="Forfeit winner score" value={rules.forfeitScore.winner} max={999} onChange={(v) => set({ forfeitScore: { ...rules.forfeitScore, winner: v } })} />
        <NumberField label="Forfeit loser score" value={rules.forfeitScore.loser} max={999} onChange={(v) => set({ forfeitScore: { ...rules.forfeitScore, loser: v } })} />
        <label>
          Score differential cap per result
          <input type="number" min={1} max={999} step={1} placeholder="No cap" value={rules.scoreDifferentialCap ?? ""} onChange={(e) => set({ scoreDifferentialCap: e.target.value === "" ? null : Number(e.target.value) })} />
        </label>
        {(["played", "forfeit"] as const).map((outcome) => (
          <label key={outcome} className="toggle">
            <input type="checkbox" checked={rules.countedOutcomes.includes(outcome)} onChange={(e) => set({ countedOutcomes: toggle(rules.countedOutcomes, outcome, e.target.checked) })} />
            Count {outcome} results in standings
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Tied-score deciders</legend>
        <p className="small muted">Required for knockout matches and leagues without draws.</p>
        {KNOCKOUT_DECIDERS_ALL.map((decider) => (
          <label key={decider} className="toggle">
            <input type="checkbox" checked={rules.knockoutDeciders.includes(decider)} onChange={(e) => set({ knockoutDeciders: toggle(rules.knockoutDeciders, decider, e.target.checked) })} />
            {DECIDER_LABELS[decider]}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Tie-breakers, in order</legend>
        <p className="small muted">Applied once to the original tied group. Exhausted criteria leave a shared rank.</p>
        <ol>
          {rules.tieBreakers.map((item, index) => (
            <li key={item}>
              {TIE_BREAKER_LABELS[item]}{" "}
              <button type="button" aria-label={`Move ${TIE_BREAKER_LABELS[item]} up`} disabled={index === 0} onClick={() => move(index, -1)}>Up</button>{" "}
              <button type="button" aria-label={`Move ${TIE_BREAKER_LABELS[item]} down`} disabled={index === rules.tieBreakers.length - 1} onClick={() => move(index, 1)}>Down</button>{" "}
              <button type="button" aria-label={`Remove ${TIE_BREAKER_LABELS[item]}`} disabled={rules.tieBreakers.length === 1} onClick={() => set({ tieBreakers: rules.tieBreakers.filter((value) => value !== item) })}>Remove</button>
            </li>
          ))}
        </ol>
        {TIE_BREAKERS.filter((item) => !rules.tieBreakers.includes(item)).map((item) => (
          <button key={item} type="button" onClick={() => set({ tieBreakers: [...rules.tieBreakers, item] })}>Add {TIE_BREAKER_LABELS[item]}</button>
        ))}
      </fieldset>
    </>
  );
}

function ResultForm({ services, orgId, detail, match, onSaved, onDenied }: { services: BrowserServices; orgId: string; detail: CompetitionDetail; match: Match; onSaved: () => void; onDenied: () => void }) {
  const result = match.result;
  const correcting = result?.status === "final";
  const start: ResultValues = (correcting ? result!.final : result?.proposal) ?? { outcome: "played", homeScore: null, awayScore: null, forfeitingTeamId: null, winnerTeamId: null, decider: null };
  const [outcome, setOutcome] = useState<ResultOutcome>(start.outcome);
  const [home, setHome] = useState(start.homeScore === null || start.outcome === "forfeit" ? "" : String(start.homeScore));
  const [away, setAway] = useState(start.awayScore === null || start.outcome === "forfeit" ? "" : String(start.awayScore));
  const [forfeiting, setForfeiting] = useState(start.forfeitingTeamId ?? "");
  const [winner, setWinner] = useState(start.decider ? start.winnerTeamId ?? "" : "");
  const [decider, setDecider] = useState<KnockoutDecider | "">(start.decider ?? "");
  const [reason, setReason] = useState("");
  const name = (teamId: string) => detail.teams.find((team) => team.teamId === teamId)?.name ?? "Unavailable team";
  const tied = outcome === "played" && home !== "" && home === away;
  const values = (): ResultValues => outcome === "void"
    ? { outcome, homeScore: null, awayScore: null, forfeitingTeamId: null, winnerTeamId: null, decider: null }
    : outcome === "forfeit"
      ? { outcome, homeScore: null, awayScore: null, forfeitingTeamId: forfeiting || null, winnerTeamId: null, decider: null }
      : { outcome, homeScore: Number(home), awayScore: Number(away), forfeitingTeamId: null, winnerTeamId: tied && winner ? winner : null, decider: tied && decider ? decider : null };
  const deciders = detail.competition.activeRules?.knockoutDeciders ?? [];
  return (
    <section className="panel" aria-label={correcting ? "Correct final result" : "Finalize result"}>
      <h2>{correcting ? "Correct final result" : "Finalize result"}</h2>
      <p className="muted">{`${name(match.homeTeamId)} (home) vs ${name(match.awayTeamId)} (away)`}</p>
      {result?.proposal && !correcting && <p className="notice">Coach proposal: {describeResult(result.proposal, name)}</p>}
      <Mutation
        label={correcting ? "Save correction" : "Finalize result"}
        onSaved={onSaved}
        onDenied={onDenied}
        action={() => {
          const requestId = crypto.randomUUID();
          const payload = { eventId: match.eventId, result: values() };
          const envelope = { requestId, orgId, resourceId: detail.competition.competitionId, expectedRevision: result?.revision ?? 0 };
          return () => correcting
            ? services.call("correctResult", { ...envelope, payload: { ...payload, reason: reason.trim() } })
            : services.call("finalizeResult", { ...envelope, payload });
        }}
      >
        <div className="form-grid">
          <label>
            Outcome
            <select value={outcome} onChange={(e) => setOutcome(e.target.value as ResultOutcome)}>
              <option value="played">Played</option>
              <option value="forfeit">Forfeit</option>
              <option value="void">Void (counts for nothing)</option>
            </select>
          </label>
          {outcome === "played" && (
            <>
              <label>{name(match.homeTeamId)} score<input type="number" min={0} max={999} step={1} required value={home} onChange={(e) => setHome(e.target.value)} /></label>
              <label>{name(match.awayTeamId)} score<input type="number" min={0} max={999} step={1} required value={away} onChange={(e) => setAway(e.target.value)} /></label>
            </>
          )}
          {outcome === "forfeit" && (
            <label>
              Team that forfeited
              <select required value={forfeiting} onChange={(e) => setForfeiting(e.target.value)}>
                <option value="">Choose a team</option>
                <option value={match.homeTeamId}>{name(match.homeTeamId)}</option>
                <option value={match.awayTeamId}>{name(match.awayTeamId)}</option>
              </select>
            </label>
          )}
          {tied && deciders.length > 0 && (
            <>
              <label>
                Winner after tie
                <select value={winner} onChange={(e) => setWinner(e.target.value)}>
                  <option value="">{detail.competition.format === "knockout" ? "Choose the winner" : "No winner (draw)"}</option>
                  <option value={match.homeTeamId}>{name(match.homeTeamId)}</option>
                  <option value={match.awayTeamId}>{name(match.awayTeamId)}</option>
                </select>
              </label>
              <label>
                Decided by
                <select value={decider} onChange={(e) => setDecider(e.target.value as KnockoutDecider | "")}>
                  <option value="">Not decided</option>
                  {deciders.map((item) => <option key={item} value={item}>{DECIDER_LABELS[item]}</option>)}
                </select>
              </label>
            </>
          )}
          {correcting && (
            <label>
              Correction reason
              <textarea required maxLength={RESULT_REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
          )}
        </div>
      </Mutation>
    </section>
  );
}

function statusLabel(match: Match, name: (teamId: string) => string) {
  const result = match.result;
  if (result?.status === "final" && result.final) return `Final: ${describeResult(result.final, name)}${result.final.correctedAt ? " (corrected)" : ""}`;
  if (result?.proposal) return `Pending proposal: ${describeResult(result.proposal, name)}`;
  if (match.status === "cancelled" || match.status === "postponed") return `${match.status[0].toUpperCase()}${match.status.slice(1)}, no result`;
  return "No result";
}

export function Competitions({ services, orgId, programId: initialProgram }: { services: BrowserServices; orgId: string; programId: string }) {
  const [programId, setProgramId] = useState(initialProgram);
  const [programs, setPrograms] = useState<AdminEntity[]>([]);
  const [hierarchy, setHierarchy] = useState<ProgramData | null>(null);
  const [competitions, setCompetitions] = useState<CompetitionSummary[]>([]);
  const [detail, setDetail] = useState<CompetitionDetail | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [confirmPolicy, setConfirmPolicy] = useState(false);
  const [match, setMatch] = useState<Match | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [denied, setDenied] = useState(false);
  const fail = (reason: unknown) => {
    if (["functions/permission-denied", "functions/unauthenticated"].includes(errorCode(reason))) setDenied(true);
    setError(message(reason));
  };

  useEffect(() => {
    allPages((next) => services.call("listOrganizationHierarchy", { orgId, kind: "program", ...(next ? { cursor: next } : {}) }))
      .then(setPrograms)
      .catch(fail);
  }, [orgId, services]);

  const loadProgram = useCallback(async () => {
    if (!programId) return;
    const list = (kind: "season" | "division" | "team") =>
      allPages((next) => services.call("listOrganizationHierarchy", { orgId, kind, programId, ...(next ? { cursor: next } : {}) }));
    const [seasons, divisions, teams, listed] = await Promise.all([list("season"), list("division"), list("team"), services.call("listCompetitions", { orgId, programId })]);
    setHierarchy({ programId, seasons, divisions, teams });
    setCompetitions(listed.competitions);
  }, [orgId, programId, services]);

  useEffect(() => {
    setDetail(null);
    setSetup(null);
    setHierarchy(null);
    setError("");
    loadProgram().catch(fail);
  }, [loadProgram]);

  const open = async (competitionId: string, page: string | null = null) => {
    setError("");
    setMatch(null);
    try {
      const value = await services.call("getCompetition", { orgId, competitionId, ...(page ? { cursor: page } : {}) });
      setDetail(value);
      setCursor(page);
      setConfirmPolicy(false);
      const c = value.competition;
      setSetup({ competitionId: c.competitionId, revision: c.revision, name: c.name, seasonId: c.seasonId, divisionId: c.divisionId ?? "", format: c.format, teamIds: c.teamIds, rules: c.draftRules, locked: c.finalResultCount > 0 });
    } catch (reason) {
      fail(reason);
    }
  };

  if (denied) {
    return (
      <main id="main-content" tabIndex={-1} className="page">
        <h1>Competitions and results</h1>
        <p className="error" role="alert">{error}</p>
      </main>
    );
  }
  const teamName = (teamId: string) => hierarchy?.teams.find((team) => team.id === teamId)?.name ?? detail?.teams.find((team) => team.teamId === teamId)?.name ?? "Unavailable team";
  const eligibleTeams = setup ? (hierarchy?.teams ?? []).filter((team) => team.seasonId === setup.seasonId && (!setup.divisionId || team.divisionId === setup.divisionId) && team.status !== "archived") : [];
  const save = (confirm: boolean) => () => {
    const requestId = crypto.randomUUID();
    const current = setup!;
    return () => services.call("saveCompetitionRules", {
      requestId, orgId, resourceId: current.competitionId, expectedRevision: current.revision,
      payload: { programId, seasonId: current.seasonId, divisionId: current.divisionId || null, name: current.name, format: current.format, teamIds: current.teamIds, rules: current.rules, confirm },
    });
  };
  const saved = (text: string) => () => {
    setNotice(text);
    void loadProgram().then(() => open(setup!.competitionId)).catch(fail);
  };
  const isNew = setup && !detail;

  return (
    <main id="main-content" tabIndex={-1} className="page competitions">
      <p className="eyebrow">League operations</p>
      <h1>Competitions and results</h1>
      <p className="muted">Configure league rules explicitly, then finalize coach-proposed results. Nothing is assumed from the sport.</p>
      {notice && <p className="notice" role="status">{notice}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="toolbar">
        <label>
          Program
          <select value={programId} onChange={(e) => setProgramId(e.target.value)}>
            <option value="">Choose a program</option>
            {programs.map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}
          </select>
        </label>
        {programId && hierarchy?.programId === programId && (
          <button className="primary" type="button" onClick={() => {
            setDetail(null);
            setNotice("");
            setConfirmPolicy(false);
            setSetup({ competitionId: crypto.randomUUID().replace(/-/g, ""), revision: 0, name: "", seasonId: hierarchy?.seasons[0]?.id ?? "", divisionId: "", format: "league", teamIds: [], rules: draftRulesTemplate(), locked: false });
          }}>New competition</button>
        )}
      </div>
      {programId && (
        <section className="panel" aria-label="Competitions">
          <h2>Competitions</h2>
          {competitions.length === 0 ? <p className="muted">No competitions in this program yet.</p> : (
            <ul>
              {competitions.map((item) => (
                <li key={item.competitionId}>
                  <button type="button" className="link" aria-current={detail?.competition.competitionId === item.competitionId ? "true" : undefined} onClick={() => void open(item.competitionId)}>{item.name}</button>{" "}
                  <span className={`badge${item.rulesState === "confirmed" ? "" : " quiet"}`}>{item.rulesState === "confirmed" ? `Rules v${item.activeRulesVersion} confirmed` : item.activeRulesVersion ? `Draft changes, v${item.activeRulesVersion} active` : "Draft rules, not confirmed"}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {setup && (
        <section className="panel" aria-label="Competition setup">
          <h2>{isNew ? "New competition" : `Setup: ${setup.name}`}</h2>
          {detail && (
            <p className={detail.competition.rulesState === "confirmed" ? "notice" : "error"} role="status">
              {detail.competition.rulesState === "confirmed"
                ? `Confirmed rules version ${detail.competition.activeRulesVersion} is active. Results finalize under this version.`
                : detail.competition.activeRulesVersion
                  ? `Draft changes are not confirmed. Version ${detail.competition.activeRulesVersion} stays active until you confirm.`
                  : "Rules are a draft. Results cannot be finalized until a competition manager confirms league policy."}
            </p>
          )}
          <div className="form-grid">
            <label>Name<input required maxLength={120} value={setup.name} onChange={(e) => setSetup({ ...setup, name: e.target.value })} /></label>
            <label>
              Season
              <select required disabled={!isNew} value={setup.seasonId} onChange={(e) => setSetup({ ...setup, seasonId: e.target.value, divisionId: "", teamIds: [] })}>
                <option value="">Choose a season</option>
                {hierarchy?.seasons.map((season) => <option key={season.id} value={season.id}>{season.name}</option>)}
              </select>
            </label>
            <label>
              Division
              <select disabled={!isNew} value={setup.divisionId} onChange={(e) => setSetup({ ...setup, divisionId: e.target.value, teamIds: [] })}>
                <option value="">Any division in the season</option>
                {hierarchy?.divisions.filter((division) => division.seasonId === setup.seasonId).map((division) => <option key={division.id} value={division.id}>{division.name}</option>)}
              </select>
            </label>
            <label>
              Format
              <select disabled={!isNew} value={setup.format} onChange={(e) => {
                const format = e.target.value as CompetitionFormat;
                setSetup({ ...setup, format, rules: format === "knockout" ? { ...setup.rules, allowDraws: false, points: { ...setup.rules.points, draw: 0 } } : setup.rules });
              }}>
                <option value="league">League</option>
                <option value="knockout">Knockout</option>
              </select>
            </label>
          </div>
          <fieldset disabled={setup.locked}>
            <legend>Teams {setup.locked && "(locked after the first final result)"}</legend>
            {eligibleTeams.length === 0 && <p className="muted">No active teams in this season and division.</p>}
            {eligibleTeams.map((team) => (
              <label key={team.id} className="toggle">
                <input type="checkbox" checked={setup.teamIds.includes(team.id)} onChange={(e) => setSetup({ ...setup, teamIds: e.target.checked ? [...setup.teamIds, team.id] : setup.teamIds.filter((value) => value !== team.id) })} />
                {team.name}
              </label>
            ))}
          </fieldset>
          <RulesEditor rules={setup.rules} format={setup.format} onChange={(rules) => setSetup({ ...setup, rules })} />
          <div className="actions">
            <Mutation label="Save draft" action={save(false)} onSaved={saved("Draft saved. It is not active until confirmed.")} onDenied={() => setDenied(true)} />
            <Mutation label="Confirm rules" action={save(true)} onSaved={saved("Rules confirmed as league policy.")} onDenied={() => setDenied(true)}>
              <label className="toggle">
                <input type="checkbox" required checked={confirmPolicy} onChange={(e) => setConfirmPolicy(e.target.checked)} />
                I confirm these rules match our approved league policy.
              </label>
            </Mutation>
          </div>
          {detail && detail.rulesVersions.length > 0 && (
            <details>
              <summary>Confirmed versions</summary>
              <ul>{detail.rulesVersions.map((row) => <li key={row.version}>Version {row.version}, confirmed {new Date(row.confirmedAt).toLocaleString()}</li>)}</ul>
            </details>
          )}
        </section>
      )}
      {detail && (
        <section className="panel" aria-label="Match results">
          <h2>Match results</h2>
          {detail.matches.length === 0 ? <p className="muted">No published matches between competition teams on this page.</p> : (
            <div className="table-scroll" tabIndex={0}>
              <table>
                <thead><tr><th scope="col">Match</th><th scope="col">Starts</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead>
                <tbody>
                  {detail.matches.map((row) => (
                    <tr key={row.eventId}>
                      <td><strong>{teamName(row.homeTeamId)}</strong> vs <strong>{teamName(row.awayTeamId)}</strong></td>
                      <td>{row.startsAt ? new Date(row.startsAt).toLocaleString() : "Unscheduled"}</td>
                      <td>{statusLabel(row, teamName)}</td>
                      <td><button type="button" onClick={() => setMatch(row)}>{row.result?.status === "final" ? "Correct" : "Finalize"}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="actions">
            {cursor && <button type="button" onClick={() => void open(detail.competition.competitionId)}>First page</button>}
            {detail.nextCursor && <button type="button" onClick={() => void open(detail.competition.competitionId, detail.nextCursor)}>Next page</button>}
          </div>
        </section>
      )}
      {detail && match && (
        <ResultForm
          key={`${match.eventId}:${match.result?.revision ?? 0}`}
          services={services}
          orgId={orgId}
          detail={detail}
          match={match}
          onDenied={() => setDenied(true)}
          onSaved={() => {
            setNotice(match.result?.status === "final" ? "Correction saved with its reason in the history." : "Result finalized.");
            void open(detail.competition.competitionId, cursor);
          }}
        />
      )}
    </main>
  );
}
