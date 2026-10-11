# Agent lessons

## Lessons

### 2026-10-10: Trace publication visibility through every state

- **Source:** PR #4, Greptile review.
- **Gap:** The bulk schedule plan required published events and a committed operation for reads, but omitted the event transition before committing the operation.
- **Going forward:** For staged workflows, specify each write needed to satisfy the reader's complete visibility predicate. Verify both invisibility before commit and visibility of the entire expected set after commit, including crash and retry between transition chunks.
- **Pointers:** Phase 2 schedule publication algorithm and P2.07 acceptance fixture in `docs/features/phase-2-league-operations-feature-plan.md`.
