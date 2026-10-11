# Phase implementation plans and feasibility evidence

Recorded: 2026-10-10. Status: planned, implementation not started. Product scope is approved; **business model selection pending**. These documents elaborate the [product plan](product-plan.md), informed by [anonymized competitive research](../research/competitive-context.md).

## Plans and execution order

| Phase | Dedicated plan | Bounded steps | Depends on |
| --- | --- | --- | --- |
| 1 | [Organization, household, and season foundations](../features/phase-1-foundations-feature-plan.md) | 15 | Existing authentication, team and event foundation; authorization hardening first. |
| 2 | [League and game-day operations](../features/phase-2-league-operations-feature-plan.md) | 20 | Phase 1 tenant, participant, guardian, roster, time, and server mutation contracts. |
| 3 | [Coaching, competition, and program insight](../features/phase-3-coaching-competition-feature-plan.md) | 14 | Phase 1 identities and roles; Phase 2 events, attendance, facilities, and audited mutations. |
| 4 | [Registration and financial operations](../features/phase-4-registration-finance-feature-plan.md) | 20 | Phase 1 tenancy and participants; Phase 2 delivery and operations; commercial and payment activation gates. |

Run `implement-feature` against a dedicated plan to implement one numbered step and open a PR for that step. Stop after verification, UI evidence where relevant, and AI review follow-up. Advance only on another user instruction. Keep implementation, PR review, and merge status separate in each plan's Handoff. A phase is not complete when only its first step is implemented.

Cross-phase contracts are owned by the earliest phase that introduces them. Later plans may add fields or projections but must not silently replace earlier identity, authorization, time, or mutation contracts. Confirm those contracts in the prerequisite PRs before starting dependent work. Use additive migrations and explicit compatibility gates rather than assuming all installed clients upgrade at once.

The shared baseline uses organization-local participant IDs, canonical guardian grants, one event per match with nonempty `teamIds` and compatibility `teamId = teamIds[0]`, UTC instants plus an IANA timezone, and separate event `publicationState` and lifecycle `status`. Mutations use client `requestId` and `expectedRevision`; server-generated `operationId` identifies work and audit records. Missing RSVP is derived unanswered, while missing attendance remains unknown. Private account projections aid discovery and never grant authority. Each phase defines the detailed fields and checks it owns.

## What counts as feasibility evidence

| Evidence level | Meaning | What it does not prove |
| --- | --- | --- |
| Source-confirmed | A named existing module or configuration demonstrates the starting capability or limitation. | A newly proposed integration works. |
| Executed baseline | A recorded command ran successfully against existing code. | Future schemas, authorization, device behavior, or load performance. |
| Documentation-supported | Authoritative documentation supports a specific API or mechanism. | Credentials, runtime integration, delivery guarantees, or production capacity. |
| Spike required | A bounded prototype, emulator test, device capture, or benchmark is defined with a pass/fail gate. | Success before that experiment is executed. |
| External decision or enablement | Provider accounts, commercial choices, content rights, target rules, or buyer requirements must be supplied or validated. | A technical design can substitute for those decisions. |

Every plan must map each capability to evidence and a verification gate. No phase plan should claim production readiness from documentation alone. Where proof needs unbuilt functionality, the plan records the exact experiment needed rather than presenting it as already passed. This planning change does not deploy infrastructure, migrate participant data, enable billing, or exercise production services.

## Baseline checks actually executed

Repository inspected: `d66e89b` on 2026-10-10. Checks below ran before application implementation; only planning documents are changed by this work.

| Check | Observed result | Practical limit |
| --- | --- | --- |
| `yarn install --frozen-lockfile --ignore-scripts` at repository root | Passed; locked client dependencies installed without lifecycle scripts. | Does not install native pods or produce a simulator/device build. |
| `yarn typecheck` | Passed. | Existing client types only; server source is excluded by root configuration. |
| `yarn test:coverage --ci --runInBand` | Passed: 13 suites, 93 tests, configured coverage thresholds satisfied. | Existing tests mock backend services; they do not prove security rules or new phase functionality. |
| Local runtime inventory | Client checks used Node 26.3.0; bundled alternative is Node 24.19.0. | CI and server runtime target Node 22; exact server-runtime parity must be validated separately. |
| `yarn install --frozen-lockfile --ignore-scripts` in `functions/` | Default install rejected local Node 26 because the package requires Node 22. | This is a tooling prerequisite, not evidence of an application defect. |
| Server dependency install under bundled Node 24 with `--frozen-lockfile --ignore-scripts --ignore-engines`, followed by `node node_modules/typescript/bin/tsc --noEmit` in `functions/` | Compile-only check passed; no emitted server code or deployment. | Engine bypass was only for this compile check. It does not validate the required Node 22 runtime or execute the server handlers. |
| `xcrun simctl list devices available` | An iOS 26.5 runtime and available phone/tablet simulator targets were listed. | No app build was installed or visually verified by this inventory. |
| Owner-app scoped recurrence, geography, and check-in reference tests | Passed: 3 suites, 16 tests; exact command and source pointers in Phase 2. | Existing pure logic only; no native port, actual presence verification, league solver, or backend integration proved. |
| Owner-app scoped pitch geometry and marker reference tests | Passed: 2 suites, 11 tests; exact command and source pointers in Phase 3. | Existing geometry and web marker behavior only; no native rendering, gesture, lineup persistence, or playing-time proof. |

Additional executed checks, including reusable pure logic from the owner's existing soccer app, are recorded in the corresponding phase plan. Those tests demonstrate only the tested existing logic, not a complete native port or the proposed end-to-end feature.

## Shared release gates

- Tenant isolation: close permissive legacy access and test direct reads, queries, role escalation, and server authorization using synthetic data before organization rollout.
- Household access: prove participant identities, guardian verification/revocation, and private cross-organization projections without sharing a person's complete profile across tenants.
- Native and web boundaries: verify the selected web entrypoint independently of native authentication imports. Do not assume a native app's web script creates a working administrative application.
- Device behavior: inspect captures from the actual native app for changed native UI; a web capture is not a substitute. Push receipt, offline state, accessibility, and denied permissions require their own device tests.
- Reliability: use idempotent server commands and resumable jobs for retries; reconcile projections and explain stale states. Do not promise exactly-once external delivery.
- Finance: prove capacities, waitlists, discounts, payment retries, refunds, and reconciliation in a test environment before accepting live money. Payment-provider and business-model decisions remain pending.
- Operations: document ownership, budget limits, failed-job handling, observability, migration cutover, and rollback before pilot deployment.

## Handoff

Planning documents are the deliverable for this task. No application implementation is authorized by creating them. Start future implementation with Phase 1's first bounded step after reviewing its evidence matrix and prerequisite gates; update this index if a verified contract or dependency changes.
