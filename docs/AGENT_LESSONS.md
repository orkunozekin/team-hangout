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

### 2026-10-12 — Separate visibility and transient read failures from authorization

- **Source:** PR #13 · Greptile
- **Gap:** Returning to the foreground reloaded a hidden household tab, and temporary browser read errors cleared unsaved participant edits as though permission had been revoked.
- **Going forward:** Require both navigation focus and active app state before loading private household data. Clear editors only for confirmed authorization loss; preserve unsaved fields and provide scoped retries for temporary read failures. Test background transitions while another tab is selected and interrupted reads during active edits.
- **Pointers:** `src/screens/HouseholdScreen.tsx`, `admin/src/Participants.tsx` and their regression tests.

### 2026-10-12 — Invitation generations and delayed access reads

- **Source:** PR #14 · Greptile
- **Gap:** Resend retained a former approver, inspection omitted acceptance eligibility checks, and delayed invitation reads could restore data after denial.
- **Going forward:** Bind each invitation generation to its current approving actor while preserving creator history, share eligibility checks between preview and acceptance, and invalidate in-flight reads when authority is denied.
- **Pointers:** `functions/src/invitations/commands.ts`, `admin/src/Invitations.tsx`, invitation backend/browser regressions.

### 2026-10-12 — Keep popover menus reachable during async work

- **Source:** PR #15 · Greptile
- **Gap:** Reopening a menu focused a disabled action, and fixed popover coordinates outlived their viewport size.
- **Going forward:** Focus the first enabled action on open, close or reposition menus on viewport changes, and exercise reopen-during-request behavior alongside safe retry.
- **Pointers:** `admin/src/InvitationActions.tsx`, `admin/tests/invitations.spec.ts`.

### 2026-10-12 — Successful reads can reveal revoked scope

- **Source:** PR #16 · Greptile
- **Gap:** Calendar-only reloads cleared events on explicit denial, but a successful response with fewer authorized participants left stale names and profile buttons in surrounding household discovery.
- **Going forward:** Reconcile related private views after successful canonical refreshes as well as denied reads. Keep discovery refresh generations separate from calendar refresh dependencies to avoid loops, and cancel older responses before loading current scope.
- **Pointers:** `src/components/HouseholdAgenda.tsx`, `src/screens/HouseholdScreen.tsx`, native calendar/discovery regressions.

### 2026-10-13 — Keep owner cleanup independent of discovery

- **Source:** PR #17 · Greptile
- **Gap:** Combining saved subscription reads with team discovery hid removal controls when discovery exceeded its fanout limit, despite owner revocation remaining authorized.
- **Going forward:** Load owner cleanup records independently from optional scope discovery. Test pending and failed discovery while verifying saved records remain visible and removable.
- **Pointers:** `admin/src/CalendarSubscriptions.tsx`, `src/screens/CalendarSubscriptionsScreen.tsx`, calendar subscription UI regressions.

### 2026-10-13 — Bind confirmation to the mutable plan

- **Source:** PR #19 · Greptile
- **Gap:** CSV resolution changes retained the preview version, letting another tab broaden a checked confirmation. Team queries also applied season filters after a limit; invalid divisions stopped all row review; later rows conflicted with earlier writes in their own job; daily cleanup capped throughput at 25 jobs.
- **Going forward:** Version both source previews and mutable resolution plans and require the confirmed plan version at commit. Filter the complete target scope before limits, record row-specific failures as skippable errors, distinguish job-local revisions from outside edits, and drain bounded cleanup pages with scheduled continuation. Cover these with multi-tab, cross-season, bad-row, multi-team and multi-page regressions.
- **Pointers:** `functions/src/imports/roster.ts`, `tests/backend/imports.test.mjs`, `admin/tests/imports.spec.ts`.

### 2026-10-13 — Bound invalid preview values separately from source bytes

- **Source:** PR #19 · local acceptance audit
- **Gap:** A CSV within the 5 MB file limit could contain a field larger than Firestore's document limit, preventing the invalid row from reaching review/skip controls. Large base64 validation also needed a canonical, linear bound.
- **Going forward:** Keep canonical source bytes intact, but bound invalid field excerpts with explicit errors/warnings before persisting preview rows. Validate large base64 in linear form and test an oversized invalid record alongside a valid record through preview, skip and commit.
- **Pointers:** `functions/src/imports/roster.ts`, `tests/backend/imports.test.mjs`.

### 2026-10-13 — Bind reviews to identities and reuse bounded contact reads

- **Source:** PR #20 · Greptile
- **Gap:** Publication UI reused row-number/revision matches across different import jobs and event IDs; publishing several same-team events repeated canonical contact and serial Auth reads.
- **Going forward:** Clear confirmations on job identity changes and compare event IDs alongside revisions. Keep commit confirmation disabled until canonical rows for the displayed preview binding have loaded, including accepted-upload retries. Reuse canonical recipient results only within a transaction attempt and batch bounded Auth lookups; reauthorize on every subsequent command. Test switching saved jobs with equal row revisions and revocation after a multi-event contact review.
- **Pointers:** `admin/src/RosterImports.tsx`, `functions/src/imports/publication.ts`, schedule browser/backend regressions.

### 2026-10-13 — Fence dispatch after canonical reads

- **Source:** PR #21 · local concurrency audit
- **Gap:** A lease checked before a long canonical authorization read could expire or be cancelled before the external transport was invoked.
- **Going forward:** Recheck the owned lease and deadline after preparation and renew it immediately before dispatch. A lost lease must send nothing; unknown errors after invocation terminate as ambiguous rather than automatically retry.
- **Pointers:** `functions/src/email/worker.ts`, `tests/backend/email.test.mjs`.

### 2026-10-13 — Preserve pending mutations across private refreshes

- **Source:** PR #21 · Greptile
- **Gap:** Clearing private read data on focus unmounted the preference mutation and discarded its original pending/retry request. All read failures also looked like access loss, hiding useful report-limit and network recovery guidance.
- **Going forward:** Keep pending mutation state mounted independently from refreshed read values; block new choices until the original request settles and clear stale read values before reopening controls. Classify denied access separately from local report limits and temporary errors without exposing raw provider text. Test delayed pre-commit saves through refresh, uncertain replay, subsequent choices, report limits and recovery.
- **Pointers:** `admin/src/EmailInformation.tsx`, `admin/tests/email.spec.ts`.

### 2026-10-13 — Rehearsal failures and accessibility coverage

- **Source:** PR #22 · Greptile
- **Gap:** Fixture initialization happened outside the report finalizer, and enlarged-text tests could pass with empty tables or measure scaled targets instead of phone control size.
- **Going forward:** Include fixture setup in failure-report cleanup and inject a setup failure. Require populated changed states before asserting accessibility, and measure touch targets at an unzoomed phone viewport independently from zoom/reflow.
- **Pointers:** `scripts/rehearsal/scenarios.mjs`, `tests/backend/rehearsal-guards.test.mjs`, `admin/tests/accessibility.spec.ts`.

### 2026-10-15 — Use canonical timezone defaults and reuse read authority per transaction

- **Source:** PR #26 · GitHub Codex review
- **Gap:** New native events defaulted to the device timezone, and canonical event lists repeatedly fetched the same hierarchy and grant documents for every result.
- **Going forward:** Obtain new-event timezone defaults from the authorized canonical organization; preserve that zone as a selectable value even when it is absent from common presets. Reuse document snapshots and identical management checks only within one read transaction attempt, never across requests or retries. Test a 50-event page's document reads and revoke access before the next request.
- **Pointers:** `functions/src/operations/events.ts`, `functions/src/operations/reads.ts`, `src/screens/CreateEditEventScreen.tsx`, operational backend and native screen tests.

### 2026-10-15 — Enforce published event history across compatibility commands

- **Source:** PR #26 · GitHub Codex re-review
- **Gap:** The new lifecycle command recorded reasons/history, but the still-exported compatibility update command could edit published canonical details without those records.
- **Going forward:** Check every callable entry point when introducing a canonical mutation invariant. Route new published edits through the lifecycle command while preserving authorized, non-mutating replay and server-owned draft promotion. Test both endpoints, not only the new writer.
- **Pointers:** `functions/src/commands.ts`, `functions/src/operations/events.ts`, `tests/backend/operational-events.test.mjs`.


### 2026-10-15 — Preserve canonical instants and approved management roles

- **Source:** PR #26 · GitHub Codex re-review
- **Gap:** The native schedule sorted display wall times rather than canonical instants, and canonical event authority omitted the captain role explicitly approved in the product plan.
- **Going forward:** Sort canonical events by `startsAt`, including cross-zone and repeated-hour cases. Check proposed role changes against the approved plan, then apply the same accepted roles to live server grants and native control mapping; retain every-team authority, tenant checks and revocation on replay.
- **Pointers:** `src/lib/eventSort.ts`, `functions/src/operations/access.ts`, `src/firebase/teams.ts`, `docs/plans/product-plan.md` approved product structure.


### 2026-10-15 — Trace navigation through existing readers and revoked assignments

- **Source:** PR #26 · GitHub Codex re-review
- **Gap:** Enabling canonical active teams exposed a Team tab that still queried the legacy member directory. Revoked canonical assignments also remained preferred navigation candidates and blocked other valid teams.
- **Going forward:** Follow newly enabled navigation through every existing screen. Keep canonical teams out of legacy roster/invite flows without expanding household directory access. Filter inactive canonical assignments before choosing a team, recheck the live team read, and fall back on denied/missing candidates while surfacing service failures. Test rendered canonical and legacy tabs, retry/switching states and live revocation.
- **Pointers:** `src/screens/TeamScreen.tsx`, `src/firebase/teams.ts`, TeamScreen and membership tests, `tests/backend/operational-events.test.mjs`.


### 2026-10-15 — Separate public projections and expose bounded schedule pages

- **Source:** PR #26 · GitHub Codex full-diff review
- **Gap:** Canonical family readers exposed private notes/audit identities and full team documents; the native schedule drained all server pages. Staged type edits preserved stale matchup IDs.
- **Going forward:** Use explicit role-appropriate event/team projections and keep strict storage decoding separate from public decoding. Reauthorize private fields on live staff/coach/captain grants. Render one ordered page at a time, retain earlier results on later-page errors, and test equal-instant cursor boundaries and team switching. Recompute derived matchup fields on every accepted type-change path.
- **Pointers:** `functions/src/operations/events.ts`, `functions/src/commands.ts`, `shared/contracts.ts`, `shared/operations.ts`, `src/firebase/events.ts`, `src/screens/ScheduleScreen.tsx` and their regression tests.


### 2026-10-15 — Preserve page boundaries and defer opponent discovery

- **Source:** PR #26 · GitHub Codex full-diff re-review
- **Gap:** Reloading a cursor event after rescheduling shifted the ordering boundary and skipped intervening rows. Opponent discovery still drained all team pages during practice form setup.
- **Going forward:** Encode the original instant/document ID and authorized scope in schedule cursors rather than reconstructing the boundary from mutable records. Load optional opponent teams only on explicit request, one page per action, with retained choices and retry. Reauthorize each request and test moved boundaries, equal timestamps and grant revocation between pages.
- **Pointers:** `functions/src/operations/events.ts`, `src/firebase/events.ts`, `src/screens/CreateEditEventScreen.tsx`, operational backend and native event-screen regressions.


### 2026-10-15 — Trace lifecycle privacy through history and compatibility views

- **Source:** PR #26 · GitHub Codex full-diff re-review and CI
- **Gap:** Family history still exposed freeform staff reasons, published soft deletion bypassed cancellation history, household calendars omitted lifecycle states, and bounded schedules opened at the oldest archive. CI also caught a cursor variable's definite-assignment error that an unchecked local command sequence missed.
- **Going forward:** Public history must use an allowlist without freeform staff reasons. Guard both compatibility update and delete paths for published events while preserving authorized receipt replay and staged/legacy compatibility. Show lifecycle status consistently in household calendars, with explicit scheduled-only subscription policy. Open native schedules near current/upcoming events with bounded past navigation. Check every validation command exit and confirm the Functions build succeeds before running tests against its generated output.
- **Pointers:** canonical event readers/history, `functions/src/commands.ts`, household agenda/subscription callers, native schedule modes and full backend regressions.


### 2026-10-15 — Return live capabilities with bounded reads

- **Source:** PR #26 · GitHub Codex full-diff review
- **Gap:** Canonical Add event controls trusted stale navigation roles, and every page performed team discovery before the authorized page request repeated household discovery.
- **Going forward:** Return current mutation capability from the same authorized schedule response, including empty pages, and clear it on failed refreshes. Reuse resolved schema only to select the reader; every server page still reauthorizes current grants. Do not use platform support or cached membership as canonical mutation authority.
- **Pointers:** `functions/src/operations/events.ts`, `src/firebase/events.ts`, `src/screens/ScheduleScreen.tsx`, `App.tsx` and revocation/paging regressions.

### 2026-10-15: Keep capability refresh and object denial scoped

- **Source:** PR #27, GitHub Codex review 5540542434.
- **Gap:** A successful read-only staff refresh collapsed the selected safe catalog view; denial of an individual event lookup was treated as loss of organization catalog access.
- **Going forward:** Preserve authorized reader state when write capability is absent. Treat object lookup/assignment denial locally unless the canonical catalog request also denies access. Fence late page responses and capability results so a newer revocation or demotion cannot be undone by an older successful request. Test normal focus, unknown IDs, revocation and demotion with held in-flight responses.
- **Pointers:** `admin/src/Facilities.tsx`, `admin/tests/facilities.spec.ts`.

### 2026-10-15: Align catalog rollout and history snapshots

- **Source:** PR #27, GitHub Codex review 5540687530.
- **Gap:** Catalog reads enforced the workspace rollout flag while writes only checked the organization flag; detachment history paired null resource IDs with a previous occupancy fallback.
- **Going forward:** Apply the same rollout predicate to every catalog mutation and replay. Record consistent before/after resource identity and occupancy, including explicit null after detachment; avoid nullish fallbacks that combine states. Test flag-disabled new writes/replay and the complete immutable detachment row.
- **Pointers:** `functions/src/facilities/service.ts`, `tests/backend/facilities.test.mjs`.
