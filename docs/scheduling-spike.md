# Scheduling feasibility spike

P2.05 is an offline TypeScript experiment in `functions/src/scheduling/`. It exports `generatePairings`, `assignSchedule` and `validateSchedule`. Nothing imports it into a callable, screen, database writer or publication path. It introduces no migration or rollout change. Rollback is removal of these unused modules and their test commands.

Use Node 22:

```sh
npm run test:scheduling
npm run benchmark:scheduling
```

The commands build Functions first and fail on any build/test/assertion failure. CI runs both the constraint tests and seeded benchmark assertions. The benchmark prints JSON with input sizes, seed, node count, assignment count, status, termination, lexicographic objective and wall/preparation/search/validation times. It checks expected outcomes, independently validates each incumbent, verifies deterministic node-budget/exhaustive replay (and explicitly reports when a wall deadline prevents that assertion), and checks complete witnesses for the large feasible inputs. Runtime values are measurements on the executing machine, not latency assertions.

## Input boundary

The module consumes a finite, already-authorized snapshot: teams and assigned coach IDs, required division sport/duration/rest, one explicit season, resources with resolved availability/closures/buffers, UTC slots, team blackouts and anonymous existing busy intervals. It performs no discovery or authorization. Before future integration, the server must resolve live tenant ownership, active grants, current effective availability/closure revisions and existing event occupancy; navigation projections and support roles confer no authority. A generated draft reserves nothing. P2.07 must independently re-read and revalidate before publication.

Bounds reject rather than truncate: 2–32 teams, 16 elapsed UTC weeks, 1,000 slots, 32 resources, 1,000 existing busy intervals, 128 intervals per entity, eight coaches per team and one or two explicit round-robin repetitions. Duration is 1–1,440 minutes; team rest is 0–10,080 minutes; resource buffers are 0–1,440 minutes. There are at most 992 required fixtures. Resources support soccer, basketball and football. Candidate slots may be invalid for duration, season or availability; they are rejected as candidates with diagnostics, rather than silently changing their times.

All intervals are positive, half-open `[start,end)`. Times must be canonical UTC ISO strings, with seconds and optional three-digit milliseconds; an explicit IANA timezone is retained as context. Local date/time expansion and DST offset selection belong to P2.04. Ambiguous/repeated wall times and nonexistent wall times cannot enter through an offset-free timestamp. Search compares instants and elapsed rest, including both occurrences of a repeated hour. Season bounds apply to playing time; setup and cleanup must fit resource availability and avoid closures/other resource occupancy. Adjacent availability intervals may jointly cover occupancy. Team blackouts/rest and coach overlap apply to playing time. Two teams sharing a coach in the same fixture occupy one coach interval; the coach cannot attend overlapping distinct fixtures.

`busy` includes resolved existing resource occupancy plus team/coach intervals across the authorized scope. External coaching conflicts require coach-approved anonymous busy data. `crossOrganizationBusy` must explicitly be `notChecked` or `coachApprovedBusyProvided`; every result discloses the limitation. The module cannot infer whether a caller supplied complete or authorized data and never returns external event details.

## Pairing, search and validation

The circle method separates complete pairings from slot assignment. IDs depend on cycle and the sorted team pair. Odd divisions get exactly one rotating bye per team per cycle and equal planned home/away counts. Even divisions have planned home/away difference at most one; a second cycle reverses orientation. Byes describe pairing rounds, not calendar weeks: slot assignment does not promise one round per week or chronological round order.

Search filters static candidates, orders fixtures by smallest static domain first, and uses canonical ID ordering with a seeded tie-break. Bounded depth-first backtracking explores candidate assignments and an explicit unassigned branch, retaining the best hard-valid incumbent. Each candidate attempt, including rejected dynamic conflicts, and each unassigned branch consumes a node. The ceiling is 100,000 nodes or 10,000 ms from algorithm entry through normalization/preparation/search, whichever is encountered first; options can only lower these limits. Deadline checks are cooperative between candidate attempts. Independent final validation is mandatory and timed separately, so total return latency includes validation and small bounded bookkeeping beyond the search deadline. The injectable monotonic clock is for deterministic deadline tests.

The objective is lexicographic: unassigned fixtures, maximum absolute home/away imbalance, maximum minus minimum team late-slot count, then unmet preference count. A team with a nonempty preferred-slot list pays one penalty per assigned game outside that list. Home/away orientation stays fixed by pairing generation; search optimizes assignments/subsets, not arbitrary pairing orientations. Hard constraints never relax for fairness. Results include per-team scheduled home/away, planned byes, early/late counts, minimum observed rest (including existing team events) and unmet preferences. There is no global optimality claim.

`validator.ts` recomputes every hard constraint from the snapshot and proposed fixture/slot references. It shares only input shape checking and the canonical pairing universe with search, never search predicates, candidate domains, incremental counters or conflict caches. It rejects duplicate/unknown references and independently recomputes completeness/fairness. Actor membership uses per-snapshot sets, and coach intersections are tested only when playing intervals overlap. Search shares per-fixture actor indexes across candidate slots. Conflict details retain the first 1,000 entries, with explicit `conflictCount` and `conflictsTruncated`; validation still evaluates every pair and never treats omitted diagnostic details as validity. A valid partial result has no hard conflicts but still has required unscheduled fixtures. Unknown/duplicate references never make a schedule complete and publishable. Future administration must require both zero hard conflicts and zero unscheduled required fixtures.

| Result field | Meaning |
| --- | --- |
| `status: feasible` | All required fixtures assigned and independently hard-valid. Fairness search may still have exhausted its budget. |
| `status: impossible` | Exhaustive search proved no complete assignment exists for these fixed pairings and supplied finite slots. A valid partial incumbent may be retained. |
| `status: budgetExhausted` | Search stopped without a complete schedule. This is not proof of impossibility. |
| `completeness` | `complete`, `partial` or `empty`, independently of the stop reason. |
| `budgetReason` | `nodes`, `time` or null; a time-limited run can stop at different nodes on different machines. |
| `termination` | `exhaustive` or `budgetExhausted`, independently of feasibility. |
| `diagnostics` | Per-unscheduled-fixture static candidate counts and first-failure rejection counts. A null candidate count means preparation did not finish, not zero candidates. Remaining fixtures distinguish no candidate, exhaustive nonassignment and exhausted search. |

## Measured feasibility and limitations

The PR records the initial-head measured seed-205 runtime/input-size table from Node 22 on macOS arm64. Four teams/six serial slots complete; five odd teams/ten slots complete before fairness optimization exhausts its smaller budget. A closed-resource input is proven impossible. Four teams sharing one coach across two simultaneous resources retain one valid game and prove the full schedule impossible.

The symmetric 31/32-team inputs deliberately have 1,000 serial slots and independently validated complete witnesses. With a 1,000-node budget both searches retain only 44 fixtures; the 32-team default 100,000-node budget retains 446 of 496. These are known-feasible instances reported truthfully as budget-exhausted. Candidate preparation dominates the smaller budgets; repeated dynamic collision attempts consume much of the larger budget. This prototype establishes correctness/result semantics and exposes a search-quality limitation at the maximum input size. It does not establish reliable completion or production capacity for arbitrary 32-team divisions. Future draft administration must preserve partial results and diagnostics; stronger assignment heuristics or narrower pilot sizes need measured evidence before making a completion promise.

The first actual Codex review identified linear coach-array scans in independent validation at the accepted actor-heavy boundary. After interval prefiltering and Set indexes, a complete 32-team/two-cycle witness (992 fixtures, 1,000 slots, 1,000 busy intervals, 256 coach IDs per busy interval, 16 coaches per fixture) validated in 455.99 ms on Node 22/macOS arm64. This is validator-only timing, not a claim that bounded search solves the actor-heavy input. The regression also introduces a common busy coach to reject all 992,000 overlaps with explicitly capped diagnostics, then moves those same busy actors to disjoint times and verifies acceptance. A focused assignment test checks the same 1,000 by 256 busy actor groups, including a match at the last actor of the last busy interval.

Tests independently cover each hard constraint, edited/duplicate references, exact interval/rest boundaries, setup/cleanup on new and existing games, explicit external-coach coverage, 31/32-team complete witnesses, rotating odd byes, home/away reversal, seeded replay, lexicographic fairness, UTC spring/fall DST instants, adversarial varied snapshots and both node/time exhaustion. Existing event/resource/recurrence/Phase 1 behavior is untouched. UI evidence is not applicable.
