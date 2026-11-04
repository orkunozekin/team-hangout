import { Fixture, Pairings, LIMITS } from './model';

/** Circle method. Round byes describe pairing rounds, not calendar weeks. */
export function generatePairings(teamIds: string[], repetitions: number): Pairings {
  if (teamIds.length < 2 || teamIds.length > LIMITS.teams || new Set(teamIds).size !== teamIds.length || teamIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) ||
      !Number.isInteger(repetitions) || repetitions < 1 || repetitions > LIMITS.repetitions) throw new Error('Invalid pairing bounds.');
  const ids = [...teamIds].sort();
  const fixtures: Fixture[] = []; const byes: Pairings['byes'] = [];
  for (let cycle = 0; cycle < repetitions; cycle++) {
    const wheel: (string | null)[] = [...ids]; if (wheel.length % 2) wheel.push(null);
    for (let round = 0; round < wheel.length - 1; round++) {
      for (let i = 0; i < wheel.length / 2; i++) {
        const a = wheel[i], b = wheel[wheel.length - 1 - i];
        if (a === null || b === null) { byes.push({ teamId: (a ?? b)!, round, cycle }); continue; }
        const ai = ids.indexOf(a), bi = ids.indexOf(b), distance = (bi - ai + ids.length) % ids.length;
        const aHome = distance < ids.length / 2 || (distance === ids.length / 2 && ai < bi);
        const home = aHome !== !!(cycle % 2) ? a : b; const away = home === a ? b : a;
        fixtures.push({ id: `${cycle}:${[a, b].sort().join(':')}`, homeTeamId: home, awayTeamId: away, round, cycle });
      }
      wheel.splice(1, 0, wheel.pop()!);
    }
  }
  return { fixtures, byes };
}
