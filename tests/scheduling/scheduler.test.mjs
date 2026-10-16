import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { sample, window, cases } from './fixtures.mjs';
const require = createRequire(import.meta.url);
const { generatePairings } = require('../../functions/lib/scheduling/pairings.js');
const { validateSchedule } = require('../../functions/lib/scheduling/validator.js');
const { assignSchedule } = require('../../functions/lib/scheduling/search.js');
const { checkInput } = require('../../functions/lib/scheduling/input.js');
const assignments = (input) => generatePairings(input.teams.map(t => t.id), input.repetitions).fixtures.map((f, i) => ({ fixtureId: f.id, slotId: input.slots[i % input.slots.length].id }));
function codes(input, rows = assignments(input)) { return validateSchedule(input, rows).conflicts.map(c => c.code); }
function twoGames() {
  const input = sample(4, 2);
  input.resources.push({ ...structuredClone(input.resources[0]), id: 'other' });
  input.slots[1] = { ...input.slots[0], id: 'second', resourceId: 'other' };
  const fs = generatePairings(input.teams.map(t => t.id), 1).fixtures;
  const a = fs[0]; const b = fs.find(f => ![a.homeTeamId, a.awayTeamId].includes(f.homeTeamId) && ![a.homeTeamId, a.awayTeamId].includes(f.awayTeamId));
  return { input, rows: [{ fixtureId: a.id, slotId: input.slots[0].id }, { fixtureId: b.id, slotId: input.slots[1].id }] };
}

for (const n of [2, 3, 5, 31, 32]) for (const repetitions of [1, 2]) {
  test(`round robin ${n} teams x ${repetitions}: complete unique pairs, rounds, home/away and rotating byes`, () => {
    const ids = sample(n).teams.map(t => t.id); const result = generatePairings(ids, repetitions);
    assert.equal(result.fixtures.length, n * (n - 1) / 2 * repetitions);
    assert.deepEqual(result, generatePairings([...ids].reverse(), repetitions));
    for (let cycle = 0; cycle < repetitions; cycle++) {
      const matches = result.fixtures.filter(f => f.cycle === cycle);
      assert.equal(new Set(matches.map(f => [f.homeTeamId, f.awayTeamId].sort().join(':'))).size, n * (n - 1) / 2);
      for (const id of ids) {
        assert.equal(matches.filter(f => f.homeTeamId === id || f.awayTeamId === id).length, n - 1);
        assert.equal(result.byes.filter(b => b.cycle === cycle && b.teamId === id).length, n % 2);
        if (n % 2) assert.equal(matches.filter(f => f.homeTeamId === id).length, (n - 1) / 2);
        for (let round = 0; round < n - 1 + n % 2; round++) {
          assert.equal(matches.filter(f => f.round === round && (f.homeTeamId === id || f.awayTeamId === id)).length + result.byes.filter(b => b.cycle === cycle && b.round === round && b.teamId === id).length, 1);
        }
        if (repetitions === 2) assert.equal(result.fixtures.filter(f => f.homeTeamId === id).length, n - 1);
      }
    }
  });
}

test('reject oversized or ambiguous inputs instead of truncating', () => {
  for (const change of [i => { i.teams = sample(33).teams; }, i => { i.slots = sample(2, 1001).slots; },
    i => { i.season = window(0, 161281); }, i => { i.repetitions = 3; }, i => { i.seed = -1; },
    i => { i.teams[0].coachIds = Array(9).fill('x'); }, i => { i.timeZone = ''; }, i => { i.timeZone = 'Invalid/Zone'; }, i => { i.timeZone = '+0500'; },
    i => { i.slots[0].startsAt = '2026-03-08T02:30:00'; }, i => { i.slots[0].startsAt = '2026-11-01T01:30:00'; },
    i => { i.slots[0].startsAt = '2026-02-30T10:00:00.000Z'; }, i => { i.slots[0].resourceId = 'missing'; },
    i => { i.teams[0].preferredSlotIds = ['missing']; }, i => { i.crossOrganizationBusy = undefined; }]) {
    const input = sample(2, 1); change(input); assert.throws(() => assignSchedule(input), /SCHEDULING_INPUT/);
  }
  assert.throws(() => generatePairings(['a', 'a'], 1)); assert.throws(() => generatePairings(['a:b', 'c'], 1));
  for (const options of [{ maxNodes: 100001 }, { maxMilliseconds: 10001 }, { maxNodes: 0 }, { maxMilliseconds: NaN }]) assert.throws(() => assignSchedule(sample(), options), /budget/);
  for (const n of [31, 32]) assert.doesNotThrow(() => checkInput(sample(n, 1000)));
});

for (const [code, mutate] of [
  ['RESOURCE_COMPATIBILITY', i => { i.resources[0].sports = ['basketball']; }],
  ['RESOURCE_COMPATIBILITY', i => { i.resources[0].active = false; }],
  ['RESOURCE_AVAILABILITY', i => { i.resources[0].availability = [window(60, 119)]; }],
  ['RESOURCE_CLOSURE', i => { i.resources[0].closures = [window(119, 130)]; }],
  ['TEAM_BLACKOUT', i => { i.teams[0].blackouts = [window(119, 130)]; }],
  ['DIVISION_DURATION', i => { i.durationMinutes = 61; }],
  ['SEASON_BOUNDS', i => { i.season = window(61, 1000); }],
]) test(`independent validator and search enforce ${code}`, () => {
  const input = sample(2, 1); mutate(input);
  assert.ok(codes(input).includes(code)); const result = assignSchedule(input);
  assert.equal(result.status, 'impossible'); assert.equal(result.assignments.length, 0); assert.equal(result.validation.unscheduledFixtureIds.length, 1);
});

test('setup, cleanup, adjacent coverage and half-open boundaries', () => {
  const i = sample(2, 1); const r = i.resources[0]; r.setupMinutes = 10; r.cleanupMinutes = 15;
  r.availability = [window(50, 100), window(100, 135)]; r.closures = [window(135, 140)];
  assert.deepEqual(codes(i), []); assert.equal(assignSchedule(i).status, 'feasible');
  r.closures = [window(134, 140)]; assert.ok(codes(i).includes('RESOURCE_CLOSURE')); assert.equal(assignSchedule(i).status, 'impossible');
  r.closures = []; r.availability = [window(50, 99), window(100, 135)]; assert.ok(codes(i).includes('RESOURCE_AVAILABILITY'));
  r.availability = [window(51, 135)]; assert.ok(codes(i).includes('RESOURCE_AVAILABILITY'));
});

test('shared coaches block disjoint teams on distinct resources; duplicates are not authority', () => {
  const { input, rows } = twoGames(); assert.deepEqual(codes(input, rows), []);
  input.teams.forEach(t => { t.coachIds = ['coach']; });
  assert.deepEqual(codes(input, rows), ['COACH_OVERLAP']);
  const result = assignSchedule(input); assert.equal(result.status, 'impossible'); assert.equal(result.assignments.length, 1);
});

test('resource collisions include both games buffers; another resource stays usable', () => {
  const { input, rows } = twoGames(); input.slots[1].resourceId = 'field';
  assert.deepEqual(codes(input, rows), ['RESOURCE_OVERLAP']);
  input.slots[1] = { ...input.slots[1], ...window(120, 180) }; assert.deepEqual(codes(input, rows), []);
  input.resources[0].cleanupMinutes = 1; assert.deepEqual(codes(input, rows), ['RESOURCE_OVERLAP']);
});

test('team overlap and minimum rest independently cover touching games and exact rest', () => {
  const i = sample(3, 2); const rows = assignments(i).slice(0, 2);
  i.slots[1] = { ...i.slots[1], ...window(60, 120) }; i.resources.push({ ...structuredClone(i.resources[0]), id: 'other' }); i.slots[1].resourceId = 'other';
  assert.ok(codes(i, rows).includes('TEAM_OVERLAP'));
  i.slots[1] = { ...i.slots[1], ...window(120, 180) }; assert.deepEqual(codes(i, rows), ['MINIMUM_REST']);
  i.slots[1] = { ...i.slots[1], ...window(150, 210) }; assert.deepEqual(codes(i, rows), []);
  const metrics = validateSchedule(i, rows).teams; assert.ok(metrics.some(m => m.minimumRestMinutes === 30));
});

for (const kind of ['resource', 'team', 'coach', 'rest']) test(`existing and approved anonymous busy: ${kind}`, () => {
  const i = sample(2, 1);
  i.busy = [{ ...window(kind === 'rest' ? 0 : 60, kind === 'rest' ? 40 : 120), teamIds: kind === 'team' || kind === 'rest' ? ['t00'] : [], coachIds: kind === 'coach' ? ['c0'] : [], resourceId: kind === 'resource' ? 'field' : null, setupMinutes: 0, cleanupMinutes: 0 }];
  i.crossOrganizationBusy = 'coachApprovedBusyProvided';
  const expected = { resource: 'RESOURCE_OVERLAP', team: 'TEAM_OVERLAP', coach: 'COACH_OVERLAP', rest: 'MINIMUM_REST' }[kind];
  assert.ok(codes(i).includes(expected)); assert.equal(assignSchedule(i).status, 'impossible');
  assert.match(validateSchedule(i, []).disclosures[0], /Only supplied/);
});

test('existing resource buffers extend beyond event start/end', () => {
  const i = sample(2, 1); i.busy = [{ ...window(0, 50), teamIds: [], coachIds: [], resourceId: 'field', setupMinutes: 0, cleanupMinutes: 11 }];
  assert.ok(codes(i).includes('RESOURCE_OVERLAP')); assert.equal(assignSchedule(i).status, 'impossible');
  i.busy[0].cleanupMinutes = 10; assert.deepEqual(codes(i), []); assert.equal(assignSchedule(i).status, 'feasible');
});

test('independent validator distrusts manual edits, missing fixtures and duplicate slots/fixtures', () => {
  const i = sample(2, 1); const rows = assignments(i);
  assert.ok(validateSchedule(i, []).valid); assert.equal(validateSchedule(i, []).unscheduledFixtureIds.length, 1);
  assert.deepEqual(codes(i, [{ fixtureId: 'foreign', slotId: 's0000' }]), ['UNKNOWN_REFERENCE']);
  assert.deepEqual(codes(i, [{ fixtureId: rows[0].fixtureId, slotId: 'missing' }]), ['UNKNOWN_REFERENCE']);
  assert.ok(codes(i, [...rows, ...rows]).includes('DUPLICATE_FIXTURE'));
  i.resources[0].closures = [window()]; assert.ok(codes(i, rows).includes('RESOURCE_CLOSURE'));
});

test('seed replay is deterministic, order independent, nonmutating and validator agrees', () => {
  const i = sample(); const before = structuredClone(i); const a = assignSchedule(i, { maxNodes: 500 });
  const b = assignSchedule(i, { maxNodes: 500 }); assert.deepEqual(a.assignments, b.assignments); assert.deepEqual(a.validation, b.validation); assert.equal(a.nodes, b.nodes);
  i.teams.reverse(); i.slots.reverse(); assert.deepEqual(a.assignments, assignSchedule(i, { maxNodes: 500 }).assignments);
  i.teams.reverse(); i.slots.reverse(); assert.deepEqual(i, before); assert.equal(a.status, 'feasible');
  assert.deepEqual(a.validation, validateSchedule(i, a.assignments)); assert.match(a.validation.disclosures[0], /not checked/);
});

test('partial exhaustive proof differs from node and elapsed budget exhaustion', () => {
  const partial = assignSchedule(sample(4, 1)); assert.equal(partial.status, 'impossible'); assert.equal(partial.completeness, 'partial'); assert.equal(partial.termination, 'exhaustive');
  const nodes = assignSchedule(sample(), { maxNodes: 2 }); assert.equal(nodes.status, 'budgetExhausted'); assert.equal(nodes.nodes, 2); assert.equal(nodes.budgetReason, 'nodes'); assert.equal(nodes.completeness, 'partial');
  let tick = 0; const timed = assignSchedule(sample(), { maxMilliseconds: 2, now: () => tick++ });
  assert.equal(timed.status, 'budgetExhausted'); assert.equal(timed.completeness, 'empty'); assert.equal(timed.budgetReason, 'time'); assert.equal(timed.termination, 'budgetExhausted');
  // A feasible incumbent remains feasible even if fairness optimization exhausts its budget.
  const feasible = assignSchedule(sample(2, 10), { maxNodes: 2 }); assert.equal(feasible.status, 'feasible'); assert.equal(feasible.termination, 'budgetExhausted');
});

test('lexicographic fairness minimizes late imbalance then unmet preferences without relaxing hard limits', () => {
  const i = sample(3, 4); i.minimumRestMinutes = 0; i.slots.forEach((s, j) => { s.late = j === 0; });
  i.teams.forEach(t => { t.preferredSlotIds = ['s0001', 's0002', 's0003']; });
  const result = assignSchedule(i); assert.equal(result.termination, 'exhaustive'); assert.deepEqual(result.validation.objective, [0, 0, 0, 0]);
  assert.ok(result.validation.teams.every(m => m.home === 1 && m.away === 1 && m.byes === 1 && m.early === 2 && m.late === 0));
  i.teams[0].blackouts = [window()]; const impossible = assignSchedule(i); assert.equal(impossible.status, 'impossible'); assert.ok(impossible.validation.valid);
});

for (const date of ['2026-03-08', '2026-11-01']) test(`DST ${date}: use elapsed UTC instants across changed offsets`, () => {
  const i = sample(2, 2); i.repetitions = 2; i.durationMinutes = 30; i.minimumRestMinutes = 30;
  i.season = { startsAt: `${date}T00:00:00.000Z`, endsAt: `${date}T23:59:59.000Z` };
  i.resources[0].availability = [i.season];
  i.slots[0] = { ...i.slots[0], startsAt: `${date}T06:30:00.000Z`, endsAt: `${date}T07:00:00.000Z` };
  i.slots[1] = { ...i.slots[1], startsAt: `${date}T07:30:00.000Z`, endsAt: `${date}T08:00:00.000Z` };
  const result = assignSchedule(i); assert.equal(result.status, 'feasible'); assert.ok(result.validation.teams.every(t => t.minimumRestMinutes === 30));
  if (date.includes('11-01')) {
    const fmt = new Intl.DateTimeFormat('en', { timeZone: i.timeZone, hour: 'numeric', minute: '2-digit' });
    assert.equal(fmt.format(new Date(i.slots[0].startsAt)), fmt.format(new Date(i.slots[1].startsAt)));
  }
});

test('all supported sports use explicit compatible resources', () => {
  for (const sport of ['soccer', 'basketball', 'football']) { const i = sample(2, 1); i.sport = sport; i.resources[0].sports = [sport]; assert.equal(assignSchedule(i).status, 'feasible'); }
});

for (const fixture of cases()) test(`seeded harness assertion: ${fixture.name}`, () => {
  const result = assignSchedule(fixture.input, fixture.options);
  assert.equal(result.status, fixture.expected); assert.ok(result.validation.valid); assert.deepEqual(result.validation, validateSchedule(fixture.input, result.assignments));
  assert.ok(result.nodes <= (fixture.options.maxNodes ?? 100000));
  assert.equal(result.assignments.length + result.validation.unscheduledFixtureIds.length, generatePairings(fixture.input.teams.map(t => t.id), fixture.input.repetitions).fixtures.length);
});


test('diagnostics distinguish zero static candidates from unfinished analysis and search limits', () => {
  const input = sample(2, 1); input.resources[0].closures = [window()];
  const result = assignSchedule(input);
  assert.deepEqual(result.diagnostics, [{ fixtureId: '0:t00:t01', candidateCount: 0, rejectedCandidates: { RESOURCE_CLOSURE: 1 }, reason: 'noCandidate' }]);
  let clock = 0; const timed = assignSchedule(sample(), { maxMilliseconds: 1, now: () => clock++ });
  assert.ok(timed.diagnostics.every(d => d.candidateCount === null && d.reason === 'budgetExhausted'));
  const partial = assignSchedule(sample(), { maxNodes: 2 });
  assert.ok(partial.diagnostics.every(d => d.candidateCount === 6 && d.reason === 'budgetExhausted'));
});

test('elapsed deadline during search retains valid incumbent and never claims impossibility', () => {
  let ticks = 0;
  const result = assignSchedule(sample(), { maxMilliseconds: 55, now: () => ticks++ });
  assert.equal(result.termination, 'budgetExhausted'); assert.ok(result.nodes > 0); assert.ok(result.assignments.length > 0);
  assert.equal(result.validation.valid, true); assert.notEqual(result.status, 'impossible');
});

test('blackout, coach busy and season endpoints use half-open canonical intervals', () => {
  const i = sample(2, 1); i.season = window(60, 120);
  i.teams[0].blackouts = [window(0, 60), window(120, 180)];
  i.busy = [{ ...window(120, 180), teamIds: [], coachIds: ['c0'], resourceId: null, setupMinutes: 0, cleanupMinutes: 0 }];
  assert.deepEqual(codes(i), []); assert.equal(assignSchedule(i).status, 'feasible');
  i.season = window(60, 119); assert.deepEqual(codes(i), ['SEASON_BOUNDS']); assert.equal(assignSchedule(i).status, 'impossible');
});

test('varied seeded adversarial snapshots independently validate every returned incumbent', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const i = sample(4, 8); i.seed = seed; i.minimumRestMinutes = seed % 3 * 30;
    i.resources.push({ ...structuredClone(i.resources[0]), id: 'other', setupMinutes: seed % 2 * 15 });
    i.slots.forEach((s, n) => { Object.assign(s, window(60 + n % 4 * 80, 120 + n % 4 * 80)); if (n % 2) s.resourceId = 'other'; });
    i.teams[seed % 4].blackouts = [window(50, 125)];
    i.resources[seed % 2].closures = [window(190, 220)];
    i.teams[0].coachIds = i.teams[2].coachIds;
    const result = assignSchedule(i, { maxNodes: 200 });
    const independent = validateSchedule(i, result.assignments);
    assert.ok(independent.valid, `seed ${seed}: ${JSON.stringify(independent.conflicts)}`);
    assert.deepEqual(result.validation, independent);
    assert.equal(result.status === 'feasible', independent.unscheduledFixtureIds.length === 0);
  }
});

for (const count of [31, 32]) test(`${count}-team full witness validates even when bounded search cannot finish`, () => {
  const input = sample(count, 1000); const rows = assignments(input);
  const validated = validateSchedule(input, rows);
  assert.equal(rows.length, count * (count - 1) / 2); assert.equal(validated.valid, true); assert.equal(validated.unscheduledFixtureIds.length, 0);
  assert.ok(validated.teams.every(t => Math.abs(t.home - t.away) <= 1 && t.byes === count % 2));
  assert.equal(assignSchedule(input, { maxNodes: 1000 }).status, 'budgetExhausted');
});
