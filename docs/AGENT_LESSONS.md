# Agent lessons

## Lessons

### 2026-10-10: Trace publication visibility through every state

- **Source:** PR #4, Greptile review.
- **Gap:** The bulk schedule plan required published events and a committed operation for reads, but omitted the event transition before committing the operation.
- **Going forward:** For staged workflows, specify each write needed to satisfy the reader's complete visibility predicate. Verify both invisibility before commit and visibility of the entire expected set after commit, including crash and retry between transition chunks.
- **Pointers:** Phase 2 schedule publication algorithm and P2.07 acceptance fixture in `docs/features/phase-2-league-operations-feature-plan.md`.

### 2026-10-10 — Nullable scope and preservation tests

- **Source:** PR #5 · Greptile
- **Gap:** Generic parent equality rejected valid events without a division; deletion assertions checked surviving document existence without detecting overwritten fields.
- **Going forward:** Test nullable scope with valid mixed-division fixtures as well as cross-org denials. For preservation guarantees, compare complete seeded data after the operation and retries.
- **Pointers:** `shared/contracts.ts`, `tests/backend/contracts.test.mjs`, `tests/backend/functions.test.mjs`.
