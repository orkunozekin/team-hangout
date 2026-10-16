import { Assignment, Interval, ScheduleInput, TeamMetrics, Validation } from './model';
import { checkInput } from './input';
import { generatePairings } from './pairings';

/** Independent constraint implementation: never imports search predicates or cached domains. */
export function validateSchedule(input: ScheduleInput, assignments: Assignment[]): Validation {
  checkInput(input);
  if (!Array.isArray(assignments) || assignments.length > 1000) throw new Error('At most 1000 assignments supported.');
  const pairings = generatePairings(input.teams.map(t => t.id), input.repetitions);
  const fixtures = new Map(pairings.fixtures.map(f => [f.id, f]));
  const slots = new Map(input.slots.map(s => [s.id, s]));
  const teams = new Map(input.teams.map(t => [t.id, t]));
  const conflicts: Validation['conflicts'] = []; const seen = new Set<string>(); let conflictCount = 0;
  const report = (code: string, ...fixtureIds: string[]) => { conflictCount++; if (conflicts.length < 1000) conflicts.push({ code, fixtureIds }); };
  const interval = (i: Interval): [number, number] => [Date.parse(i.startsAt), Date.parse(i.endsAt)];
  const intersects = (a: [number, number], b: [number, number]) => Math.max(a[0], b[0]) < Math.min(a[1], b[1]);
  const metrics = new Map<string, TeamMetrics>(input.teams.map(t => [t.id, { teamId: t.id, home: 0, away: 0,
    byes: pairings.byes.filter(b => b.teamId === t.id).length, early: 0, late: 0, minimumRestMinutes: null, unmetPreferences: 0 }]));
  const games: { id: string; time: [number, number]; occupied: [number, number]; resourceId: string; teamIds: string[]; teamSet: Set<string>; coachIds: Set<string> }[] = [];
  for (const assignment of assignments) {
    const f = fixtures.get(assignment.fixtureId); const s = slots.get(assignment.slotId);
    if (!f || !s) { report('UNKNOWN_REFERENCE', assignment.fixtureId); continue; }
    if (seen.has(f.id)) report('DUPLICATE_FIXTURE', f.id);
    seen.add(f.id);
    const r = input.resources.find(r => r.id === s.resourceId)!;
    const time = interval(s); const occupied: [number, number] = [time[0] - r.setupMinutes * 60000, time[1] + r.cleanupMinutes * 60000];
    if (!r.active || !r.sports.includes(input.sport)) report('RESOURCE_COMPATIBILITY', f.id);
    if (time[1] - time[0] !== input.durationMinutes * 60000) report('DIVISION_DURATION', f.id);
    const season = interval(input.season);
    if (time[0] < season[0] || time[1] > season[1]) report('SEASON_BOUNDS', f.id);
    // Union coverage accepts adjacent availability windows, but never a gap.
    let covered = occupied[0];
    for (const w of r.availability.map(interval).sort((a, b) => a[0] - b[0])) {
      if (w[0] > covered) break; if (w[1] > covered) covered = w[1];
    }
    if (covered < occupied[1]) report('RESOURCE_AVAILABILITY', f.id);
    if (r.closures.some(c => intersects(interval(c), occupied))) report('RESOURCE_CLOSURE', f.id);
    const teamIds = [f.homeTeamId, f.awayTeamId]; const coachIds = [...new Set(teamIds.flatMap(t => teams.get(t)!.coachIds))];
    for (const tid of teamIds) {
      const team = teams.get(tid)!; const m = metrics.get(tid)!;
      if (team.blackouts.some(b => intersects(interval(b), time))) report('TEAM_BLACKOUT', f.id);
      m[tid === f.homeTeamId ? 'home' : 'away']++; m[s.late ? 'late' : 'early']++;
      if (team.preferredSlotIds?.length && !team.preferredSlotIds.includes(s.id)) m.unmetPreferences++;
    }
    games.push({ id: f.id, time, occupied, resourceId: r.id, teamIds, teamSet: new Set(teamIds), coachIds: new Set(coachIds) });
  }
  // Existing occupancy is an anonymous authorized snapshot, including approved external busy intervals.
  const existing = input.busy.map((b, i) => ({ id: `busy:${i}`, time: interval(b),
    occupied: [Date.parse(b.startsAt) - b.setupMinutes * 60000, Date.parse(b.endsAt) + b.cleanupMinutes * 60000] as [number, number],
    resourceId: b.resourceId, teamIds: b.teamIds, teamSet: new Set(b.teamIds), coachIds: new Set(b.coachIds) }));
  for (let i = 0; i < games.length; i++) {
    const a = games[i];
    for (const b of [...games.slice(i + 1), ...existing]) {
      const ids = b.id.startsWith('busy:') ? [a.id] : [a.id, b.id];
      if (a.resourceId === b.resourceId && intersects(a.occupied, b.occupied)) report('RESOURCE_OVERLAP', ...ids);
      const sharedTeams = a.teamIds.filter(t => b.teamSet.has(t));
      if (sharedTeams.length && intersects(a.time, b.time)) report('TEAM_OVERLAP', ...ids);
      if (intersects(a.time, b.time)) {
        for (const coach of a.coachIds) if (b.coachIds.has(coach)) { report('COACH_OVERLAP', ...ids); break; }
      }
      if (sharedTeams.length) {
        const rest = (Math.max(a.time[0], b.time[0]) - Math.min(a.time[1], b.time[1])) / 60000;
        if (rest < input.minimumRestMinutes) report('MINIMUM_REST', ...ids);
        for (const t of sharedTeams) { const m = metrics.get(t)!; m.minimumRestMinutes = m.minimumRestMinutes === null ? rest : Math.min(rest, m.minimumRestMinutes); }
      }
    }
  }
  const unscheduledFixtureIds = pairings.fixtures.filter(f => !seen.has(f.id)).map(f => f.id);
  const values = [...metrics.values()].sort((a, b) => (a.teamId < b.teamId ? -1 : a.teamId > b.teamId ? 1 : 0));
  const lateCounts = values.map(m => m.late);
  return { valid: conflictCount === 0, conflictCount, conflictsTruncated: conflictCount > conflicts.length, conflicts, unscheduledFixtureIds, teams: values,
    objective: [unscheduledFixtureIds.length, Math.max(...values.map(m => Math.abs(m.home - m.away))),
      Math.max(...lateCounts) - Math.min(...lateCounts), values.reduce((n, m) => n + m.unmetPreferences, 0)],
    disclosures: [input.crossOrganizationBusy === 'notChecked' ? 'Cross-organization coach conflicts are not checked.' : 'Only supplied coach-approved external busy intervals are checked.',
      'Byes describe pairing rounds, not calendar-week rest. Home/away orientation is fixed by pairing generation. No global optimality is claimed.'] };
}
