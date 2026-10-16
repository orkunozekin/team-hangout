import { Assignment, Fixture, LIMITS, ScheduleInput, ScheduleResult, SearchOptions, Slot } from './model';
import { checkInput } from './input';
import { generatePairings } from './pairings';
import { validateSchedule } from './validator';

type Game = { start: number; end: number; occupiedStart: number; occupiedEnd: number; resourceId: string | null; teams: string[]; coaches: string[] };
const overlap = (a: number, b: number, c: number, d: number) => a < d && c < b;
function conflicts(a: Game, b: Game, rest: number) {
  if (a.resourceId === b.resourceId && a.resourceId !== null && overlap(a.occupiedStart, a.occupiedEnd, b.occupiedStart, b.occupiedEnd)) return true;
  const shared = a.teams.some(t => b.teams.includes(t));
  if (shared && (overlap(a.start, a.end, b.start, b.end) || Math.max(a.start, b.start) - Math.min(a.end, b.end) < rest * 60000)) return true;
  return a.coaches.some(c => b.coaches.includes(c)) && overlap(a.start, a.end, b.start, b.end);
}
function better(a: number[], b: number[]) { for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) return a[i] < b[i]; } return false; }
function random(seed: number) { let s = seed; return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 0x100000000; }; }

export function assignSchedule(input: ScheduleInput, options: SearchOptions = {}): ScheduleResult {
  const now = options.now ?? (() => performance.now()); const started = now();
  const maxNodes = options.maxNodes ?? LIMITS.nodes; const maxMs = options.maxMilliseconds ?? LIMITS.milliseconds;
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > LIMITS.nodes || !Number.isFinite(maxMs) || maxMs <= 0 || maxMs > LIMITS.milliseconds) throw new Error('Search budget must be positive and within 100000 nodes / 10000ms.');
  checkInput(input);
  const pairings = generatePairings(input.teams.map(t => t.id), input.repetitions);
  const teams = new Map(input.teams.map(t => [t.id, t])); const resources = new Map(input.resources.map(r => [r.id, r]));
  const existing: Game[] = input.busy.map(b => ({ start: Date.parse(b.startsAt), end: Date.parse(b.endsAt),
    occupiedStart: Date.parse(b.startsAt) - b.setupMinutes * 60000, occupiedEnd: Date.parse(b.endsAt) + b.cleanupMinutes * 60000,
    resourceId: b.resourceId, teams: b.teamIds, coaches: b.coachIds }));
  const makeGame = (f: Fixture, s: Slot): Game => {
    const r = resources.get(s.resourceId)!; const tids = [f.homeTeamId, f.awayTeamId];
    return { start: Date.parse(s.startsAt), end: Date.parse(s.endsAt), occupiedStart: Date.parse(s.startsAt) - r.setupMinutes * 60000,
      occupiedEnd: Date.parse(s.endsAt) + r.cleanupMinutes * 60000, resourceId: r.id, teams: tids, coaches: [...new Set(tids.flatMap(t => teams.get(t)!.coachIds))] };
  };
  let exhausted = false; let nodes = 0; let budgetReason: 'nodes' | 'time' | null = null;
  const timeUp = () => { if (!exhausted && now() - started >= maxMs) { exhausted = true; budgetReason = 'time'; } return exhausted; };
  const consumeNode = () => {
    if (timeUp()) return false;
    if (nodes >= maxNodes) { exhausted = true; budgetReason = 'nodes'; return false; }
    nodes++; return true;
  };
  const rng = random(input.seed);
  const slotOrder = [...input.slots].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(slot => ({ slot, tie: rng() })).sort((a, b) => a.tie - b.tie).map(v => v.slot);
  const domains: { fixture: Fixture; candidates: { slot: Slot; game: Game }[]; tie: number; rejections: Record<string, number>; fullyScanned: boolean }[] = [];
  // Static resource, blackout and existing-event filtering is separately checked by validator.ts.
  for (const fixture of pairings.fixtures) {
    const candidates: { slot: Slot; game: Game }[] = [];
    const rejections: Record<string, number> = {};
    const reject = (code: string) => { rejections[code] = (rejections[code] ?? 0) + 1; };
    for (const slot of slotOrder) {
      if (timeUp()) break;
      const game = makeGame(fixture, slot); const resource = resources.get(slot.resourceId)!;
      if (!resource.active || !resource.sports.includes(input.sport)) { reject('RESOURCE_COMPATIBILITY'); continue; }
      if (game.end - game.start !== input.durationMinutes * 60000) { reject('DIVISION_DURATION'); continue; }
      if (game.start < Date.parse(input.season.startsAt) || game.end > Date.parse(input.season.endsAt)) { reject('SEASON_BOUNDS'); continue; }
      let cursor = game.occupiedStart;
      for (const w of [...resource.availability].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))) {
        if (Date.parse(w.startsAt) > cursor) break; cursor = Math.max(cursor, Date.parse(w.endsAt));
      }
      if (cursor < game.occupiedEnd) { reject('RESOURCE_AVAILABILITY'); continue; }
      if (resource.closures.some(w => overlap(game.occupiedStart, game.occupiedEnd, Date.parse(w.startsAt), Date.parse(w.endsAt)))) { reject('RESOURCE_CLOSURE'); continue; }
      if (game.teams.some(t => teams.get(t)!.blackouts.some(w => overlap(game.start, game.end, Date.parse(w.startsAt), Date.parse(w.endsAt))))) { reject('TEAM_BLACKOUT'); continue; }
      if (existing.some(b => conflicts(game, b, input.minimumRestMinutes))) { reject('EXISTING_OCCUPANCY'); continue; }
      candidates.push({ slot, game });
    }
    domains.push({ fixture, candidates, tie: rng(), rejections, fullyScanned: !exhausted }); if (exhausted) break;
  }
  domains.sort((a, b) => a.candidates.length - b.candidates.length || a.tie - b.tie);
  const preparedAt = now();
  let best: Assignment[] = []; let bestObjective = [pairings.fixtures.length, 0, 0, 0];
  const current: Assignment[] = []; const occupied: Game[] = [];
  const home = new Map(input.teams.map(t => [t.id, 0])); const late = new Map(input.teams.map(t => [t.id, 0])); let penalty = 0;
  function remember() {
    const counts = [...late.values()]; const objective = [pairings.fixtures.length - current.length,
      Math.max(...[...home.values()].map(Math.abs)), Math.max(...counts) - Math.min(...counts), penalty];
    if (better(objective, bestObjective)) { best = [...current]; bestObjective = objective; }
  }
  function visit(index: number): void {
    remember(); if (timeUp() || index === domains.length || current.length + domains.length - index < best.length) return;
    const { fixture, candidates } = domains[index];
    for (const { slot, game } of candidates) {
      if (!consumeNode()) return;
      if (occupied.some(b => conflicts(game, b, input.minimumRestMinutes))) continue;
      current.push({ fixtureId: fixture.id, slotId: slot.id }); occupied.push(game);
      home.set(fixture.homeTeamId, home.get(fixture.homeTeamId)! + 1); home.set(fixture.awayTeamId, home.get(fixture.awayTeamId)! - 1);
      let addedPenalty = 0;
      for (const t of game.teams) { if (slot.late) late.set(t, late.get(t)! + 1); const preferences = teams.get(t)!.preferredSlotIds;
        if (preferences?.length && !preferences.includes(slot.id)) addedPenalty++; }
      penalty += addedPenalty; visit(index + 1); penalty -= addedPenalty;
      for (const t of game.teams) if (slot.late) late.set(t, late.get(t)! - 1);
      home.set(fixture.homeTeamId, home.get(fixture.homeTeamId)! - 1); home.set(fixture.awayTeamId, home.get(fixture.awayTeamId)! + 1);
      current.pop(); occupied.pop(); if (exhausted) return;
    }
    if (!consumeNode()) return; visit(index + 1); // Explicit unassigned branch retains best partial result.
  }
  if (!exhausted) visit(0);
  const searchedAt = now();
  const validation = validateSchedule(input, best);
  const validatedAt = now();
  if (!validation.valid) throw new Error('Independent scheduler validation failed.');
  return { status: best.length === pairings.fixtures.length ? 'feasible' : exhausted ? 'budgetExhausted' : 'impossible',
    completeness: best.length === pairings.fixtures.length ? 'complete' : best.length ? 'partial' : 'empty',
    termination: exhausted ? 'budgetExhausted' : 'exhaustive', assignments: best, validation,
    nodes, budgetReason, elapsedMilliseconds: validatedAt - started, seed: input.seed,
    timings: { preparationMilliseconds: preparedAt - started, searchMilliseconds: searchedAt - preparedAt, validationMilliseconds: validatedAt - searchedAt },
    diagnostics: validation.unscheduledFixtureIds.map(fixtureId => {
      const domain = domains.find(d => d.fixture.id === fixtureId);
      return { fixtureId, candidateCount: domain?.fullyScanned ? domain.candidates.length : null,
        rejectedCandidates: domain?.rejections ?? {},
        reason: domain?.fullyScanned && domain.candidates.length === 0 ? 'noCandidate' : exhausted ? 'budgetExhausted' : 'unassignedAfterSearch' };
    }) };
}
