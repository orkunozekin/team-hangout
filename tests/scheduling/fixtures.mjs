export const instant = (minutes) => new Date(Date.UTC(2026, 0, 5) + minutes * 60000).toISOString();
export const window = (start = 0, end = 10080) => ({ startsAt: instant(start), endsAt: instant(end) });
export function sample(count = 4, slots = count * (count - 1) / 2) {
  return {
    teams: Array.from({ length: count }, (_, i) => ({ id: `t${String(i).padStart(2, '0')}`, coachIds: [`c${i}`], blackouts: [] })),
    resources: [{ id: 'field', active: true, sports: ['soccer'], setupMinutes: 0, cleanupMinutes: 0, availability: [window(0, 161280)], closures: [] }],
    slots: Array.from({ length: slots }, (_, i) => ({ id: `s${String(i).padStart(4, '0')}`, resourceId: 'field', late: i % 2 === 1, ...window(i * 120 + 60, i * 120 + 120) })),
    busy: [], season: window(0, 161280), timeZone: 'America/Chicago', sport: 'soccer', durationMinutes: 60,
    minimumRestMinutes: 30, repetitions: 1, seed: 205, crossOrganizationBusy: 'notChecked',
  };
}
export function cases() {
  const impossible = sample(2, 1); impossible.resources[0].closures = [window()];
  const coach = sample(4, 1); coach.teams.forEach(t => { t.coachIds = ['shared']; });
  coach.resources.push({ ...structuredClone(coach.resources[0]), id: 'court' });
  coach.slots.push({ ...coach.slots[0], id: 'other', resourceId: 'court' });
  return [
    { name: 'known-feasible', input: sample(), options: { maxNodes: 10000 }, expected: 'feasible' },
    { name: 'impossible-closure', input: impossible, options: {}, expected: 'impossible' },
    { name: 'odd-five', input: sample(5), options: { maxNodes: 2000 }, expected: 'feasible' },
    { name: 'shared-coach-impossible', input: coach, options: {}, expected: 'impossible' },
    { name: 'boundary-31', input: sample(31, 1000), options: { maxNodes: 1000 }, expected: 'budgetExhausted' },
    { name: 'boundary-32', input: sample(32, 1000), options: { maxNodes: 1000 }, expected: 'budgetExhausted' },
    { name: 'boundary-32-full-budget', input: sample(32, 1000), options: {}, expected: 'budgetExhausted' },
    { name: 'truthful-node-exhaustion', input: sample(), options: { maxNodes: 2 }, expected: 'budgetExhausted' },
  ];
}
