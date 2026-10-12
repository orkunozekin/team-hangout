# Agent lessons

### 2026-10-11: Replay saved results before validating a patch against later state

- **Source:** PR #7, Greptile and Macroscope reviews.
- **Gap:** A successful event time patch was merged into the latest event during replay, so a later edit could make the old patch invalid and hide the original success.
- **Going forward:** Recheck current canonical authorization and scope before returning a receipt, but do not reapply or validate an already-completed mutation against later mutable state. Archive restrictions apply to new writes, while replay still rechecks canonical authority and parent integrity. Test replay after intervening edits, archival and revocation, including no extra writes or audit entries.
- **Pointers:** `functions/src/commands.ts`, `tests/backend/organizations.test.mjs`.

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

### 2026-10-11 — Validate changed preferences and isolate rule denial causes

- **Source:** PR #6 · Greptile
- **Gap:** A saved team preference was reauthorized during unrelated profile saves, blocking profiles after membership revocation. Negative preference tests omitted the now-required server timestamp, so they could pass for the wrong reason.
- **Going forward:** Gate preference authorization on that field changing. Pair each denied rules update with an otherwise-valid payload and a successful authorized counterpart, including required timestamps.
- **Pointers:** `firestore.rules`, `tests/backend/rules.test.mjs`

### 2026-10-11 — Idempotency belongs to an action, not matching payloads

- **Source:** PR #6 · Greptile re-review
- **Gap:** Keeping uncertain request IDs by payload made a later invite rotation replay an earlier result after another coach had rotated again.
- **Going forward:** Generate an ID per action and preserve it only for that action’s automatic or explicitly identified retries. Identical payloads do not establish intent to retry.
- **Pointers:** `src/firebase/commands.ts`, `src/firebase/__tests__/commands-test.ts`

### 2026-10-11 — Preserve omitted fields in partial updates

- **Source:** PR #9 · Greptile
- **Gap:** Contact-edit normalization converted omitted fields to null, so a phone-only edit erased the saved email and an email-only edit erased the phone.
- **Going forward:** Preserve key presence when normalizing patches. Distinguish omitted fields from explicit clearing, and test edits against fully populated records, including preservation of private fields and retry payload identity.
- **Pointers:** `functions/src/participants/commands.ts`, `tests/backend/participants.test.mjs`.

### 2026-10-12 — Reauthorize without discarding active actions

- **Source:** PR #12 · Greptile
- **Gap:** A window-focus refresh changed the workspace React key, silently discarding unsaved fields and the request ID retained after an uncertain save. Entry also awaited unrelated history on sections that did not use it.
- **Going forward:** Recheck canonical authority without remounting an unchanged authorized scope. Clear tenant state on actual account/scope loss. Test focus during both an unsaved edit and an accepted write whose response is lost, proving the same request is replayed once. Fetch only the records and parents required by the current section.
- **Pointers:** `admin/src/App.tsx`, `admin/src/Workspace.tsx`, `admin/src/Mutation.tsx`, `admin/tests/workspace.spec.ts`.
