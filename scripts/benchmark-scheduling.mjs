import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { cases, busyBoundary } from '../tests/scheduling/fixtures.mjs';
const require = createRequire(import.meta.url);
const { assignSchedule } = require('../functions/lib/scheduling/search.js');
const { generatePairings } = require('../functions/lib/scheduling/pairings.js');
const { validateSchedule } = require('../functions/lib/scheduling/validator.js');
const report = { node: process.version, platform: `${process.platform}/${process.arch}`, seed: 205, results: [] };
for (const fixture of cases()) {
  const start = performance.now(); const result = assignSchedule(fixture.input, fixture.options); const totalMs = performance.now() - start;
  assert.equal(result.status, fixture.expected, fixture.name); assert.equal(result.validation.valid, true);
  assert.deepEqual(result.validation, validateSchedule(fixture.input, result.assignments));
  const replay = assignSchedule(fixture.input, fixture.options);
  // A wall deadline can interrupt at different nodes on a loaded machine. Only node-limited/exhaustive runs promise exact replay.
  const deterministicReplay = result.budgetReason !== 'time' && replay.budgetReason !== 'time';
  if (deterministicReplay) { assert.deepEqual(result.assignments, replay.assignments); assert.equal(result.nodes, replay.nodes); }
  assert.ok(validateSchedule(fixture.input, replay.assignments).valid);
  let witnessAssigned = null;
  if (fixture.name.startsWith('boundary-')) {
    const rows = generatePairings(fixture.input.teams.map(t => t.id), 1).fixtures.map((f, i) => ({ fixtureId: f.id, slotId: fixture.input.slots[i].id }));
    const witness = validateSchedule(fixture.input, rows); assert.ok(witness.valid); assert.equal(witness.unscheduledFixtureIds.length, 0); witnessAssigned = rows.length;
  }
  report.results.push({ witnessAssigned, name: fixture.name, teams: fixture.input.teams.length, slots: fixture.input.slots.length,
    fixtures: result.assignments.length + result.validation.unscheduledFixtureIds.length,
    assigned: result.assignments.length, status: result.status, completeness: result.completeness, termination: result.termination,
    nodes: result.nodes, budgetReason: result.budgetReason, deterministicReplay, nodeBudget: fixture.options.maxNodes ?? 100000, wallMs: Math.round(totalMs * 100) / 100,
    preparationMs: Math.round(result.timings.preparationMilliseconds * 100) / 100, searchMs: Math.round(result.timings.searchMilliseconds * 100) / 100, validationMs: Math.round(result.timings.validationMilliseconds * 100) / 100, objective: result.validation.objective });
}
const heavy = busyBoundary();
const witnessRows = generatePairings(heavy.teams.map(t => t.id), heavy.repetitions).fixtures.map((f, i) => ({ fixtureId: f.id, slotId: heavy.slots[i].id }));
const validationStart = performance.now(); const maximum = validateSchedule(heavy, witnessRows); const validationMs = performance.now() - validationStart;
assert.ok(maximum.valid); assert.equal(maximum.unscheduledFixtureIds.length, 0);
report.results.push({ name: 'maximum-busy-independent-validation', teams: 32, slots: 1000, repetitions: 2, fixtures: 992, assigned: 992,
  busyIntervals: 1000, coachesPerBusyInterval: 256, coachesPerGame: 16, status: 'validatedCompleteWitness', validationMs: Math.round(validationMs * 100) / 100 });
console.log(JSON.stringify(report, null, 2));
