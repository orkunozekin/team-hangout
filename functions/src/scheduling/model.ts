/** Private, already-authorized snapshot only. This spike performs no discovery or writes. */
export type Interval = { startsAt: string; endsAt: string };
export type Team = { id: string; coachIds: string[]; blackouts: Interval[]; preferredSlotIds?: string[] };
export type Resource = {
  id: string; sports: string[]; active: boolean; setupMinutes: number; cleanupMinutes: number;
  availability: Interval[]; closures: Interval[];
};
export type Slot = Interval & { id: string; resourceId: string; late: boolean };
export type Busy = Interval & { teamIds: string[]; coachIds: string[]; resourceId: string | null;
  setupMinutes: number; cleanupMinutes: number };
export type ScheduleInput = {
  teams: Team[]; resources: Resource[]; slots: Slot[]; busy: Busy[];
  season: Interval; timeZone: string; sport: 'soccer' | 'basketball' | 'football';
  durationMinutes: number; minimumRestMinutes: number; repetitions: number; seed: number;
  crossOrganizationBusy: 'notChecked' | 'coachApprovedBusyProvided';
};
export type Fixture = { id: string; homeTeamId: string; awayTeamId: string; round: number; cycle: number };
export type Pairings = { fixtures: Fixture[]; byes: { teamId: string; round: number; cycle: number }[] };
export type Assignment = { fixtureId: string; slotId: string };
export type TeamMetrics = { teamId: string; home: number; away: number; byes: number; early: number; late: number;
  minimumRestMinutes: number | null; unmetPreferences: number };
export type Validation = {
  valid: boolean; conflictCount: number; conflictsTruncated: boolean; conflicts: { code: string; fixtureIds: string[] }[]; unscheduledFixtureIds: string[];
  teams: TeamMetrics[]; objective: [number, number, number, number]; disclosures: string[];
};
export type SearchOptions = { maxNodes?: number; maxMilliseconds?: number; now?: () => number };
export type ScheduleResult = {
  status: 'feasible' | 'impossible' | 'budgetExhausted'; completeness: 'complete' | 'partial' | 'empty';
  termination: 'exhaustive' | 'budgetExhausted'; assignments: Assignment[]; validation: Validation;
  nodes: number; budgetReason: 'nodes' | 'time' | null; elapsedMilliseconds: number; seed: number;
  diagnostics: { fixtureId: string; candidateCount: number | null; rejectedCandidates: Record<string, number>;
    reason: 'noCandidate' | 'unassignedAfterSearch' | 'budgetExhausted' }[];
  timings: { preparationMilliseconds: number; searchMilliseconds: number; validationMilliseconds: number };
};
export const LIMITS = { teams: 32, weeks: 16, slots: 1000, resources: 32, busy: 1000,
  intervalsPerEntity: 128, coachesPerTeam: 8, repetitions: 2, nodes: 100000, milliseconds: 10000 } as const;
