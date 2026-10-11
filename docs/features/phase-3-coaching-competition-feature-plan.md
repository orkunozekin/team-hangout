# Phase 3: Coaching, competition, and program insight

Turn the approved [product direction](../plans/product-plan.md#phase-3-coaching-competition-and-program-insight) into independently deliverable coaching, competition, volunteering, reporting, and practice-resource increments. This document specifies future implementation; no capability below is implemented by this planning change.

## Status

| Field | Value |
| --- | --- |
| Status | planned |
| Last updated | 2026-10-10 |
| Source baseline | Team Hangout `d66e89b`, inspected locally |
| Related PR / branch | Planning PR recorded by coordinating agent |
| Dependencies | Phase 1 organization/participant/season authorization and Phase 2 canonical events, attendance, facilities, communications |
| Commercial status | Business model selection pending; no feature paywall, fee, or entitlement approved |
| Next implementation step | Step 1 only, after dependency contracts pass its entry checks |

Read the [phase index and common evidence standard](../plans/phase-plans.md), [Phase 1 foundations plan](phase-1-foundations-feature-plan.md), and [Phase 2 operations plan](phase-2-league-operations-feature-plan.md) before implementation.

## Goals and boundaries

- Coaches can prepare private, sport-specific lineups, record substitutions, and explain measured playing time without publishing private notes.
- Authorized staff publish and correct results; standings and brackets remain reproducible and show unresolved ties or stale calculations explicitly.
- Households fill volunteer needs and coordinate rides without broadcasting private contacts or children's pickup details.
- Organization staff inspect attendance and booked-facility trends, export authorized data, and roll seasons forward without carrying stale privileges.
- Volunteer coaches can use age-appropriate, rights-cleared practice resources and attach a practice plan to an event.
- No livestreaming, public social feed, advanced individual analytics, AI recap, financial operation, or automated child transport matching.
- First competition engine supports league tables and single elimination. Other bracket formats remain later extensions; do not imply support through an unrestricted format selector.

## Current state and evidence

Source links resolve from this document. Line references below describe the inspected baseline and may move during implementation.

| Baseline | Confirmed observation | Implication |
| --- | --- | --- |
| [`src/types/models.ts`](../../src/types/models.ts), lines 1–6, 20–37, 51–84 | Teams have a nullable free-text sport; members are authenticated coach/player accounts; events have one team and no competition fields. | New sport presets, participant roster references, and canonical match sides depend on prior phases. |
| [`src/firebase/events.ts`](../../src/firebase/events.ts), lines 74–103, 141–169 | Event reads are direct Firestore calls; changes have no expected revision or domain audit. | New sensitive mutations use trusted callables with revision checks, not unrestricted direct updates. |
| [`firestore.rules`](../../firestore.rules), lines 26–38, 113–121 | Current authorization is team membership/coach or platform administrator. | Do not reuse these checks as organization or private coaching authorization. Phase 1 must land first. |
| [`src/lib/roles.ts`](../../src/lib/roles.ts), lines 15–22 | UI helper allows platform administrator management. | Phase 3 server checks require scoped capabilities; platform status alone grants no tenant coaching access. |
| [`functions/src/index.ts`](../../functions/src/index.ts), lines 1–25, 34–41 | Firebase Admin and authenticated v2 callable infrastructure already exist. | Backend architecture is compatible, but the only inspected callable is account deletion. |
| [`src/firebase/config.ts`](../../src/firebase/config.ts), lines 43–53 | Auth uses AsyncStorage persistence; Firestore is initialized separately. | Auth persistence does not prove durable Firestore offline persistence. Live scoring remains online-authoritative. |
| [`package.json`](../../package.json), dependencies/scripts | Expo 54, React Native 0.81.5, Firebase JS SDK, Jest and TypeScript exist; SVG, gesture handler, file export and sharing packages are not declared. | Install SDK-compatible packages only in their implementation step; rebuild native app and verify. |
| [`src/screens/EventDetailScreen.tsx`](../../src/screens/EventDetailScreen.tsx), lines 60–85 | Event detail navigation uses `eventId`. | Extend this entry point with team-scoped coaching tabs; preserve canonical event identity. |

Read-only inspection of the owner's soccer app at revision `944b43a` (no tracked changes at final verification) found relative 0–100 pitch coordinates, explicit layout-only positions, responsive inset margins, and marker-label separation in `lib/utils/pitchLayout.ts` lines 6–23, 26–68 and `components/teams/PlayerMarker.tsx`. Its `getTeamPlayers` at lines 492–500 assigns by RSVP priority and consumes account-based users. Those are reference concepts, not the new saved-lineup contract. Web DOM/CSS components, soccer-only position rules, and account-based identity must not be copied as native or multi-sport implementations.

A bounded local check actually ran in that app: `./node_modules/.bin/vitest run lib/utils/pitchMarkings.test.ts components/teams/PlayerMarker.test.tsx --reporter=dot`. Result: **2 suites, 11 tests passed**. This proves the existing geometry assertions and web marker-label tests execute, not native rendering, drag handling, or Team Hangout persistence. No app startup or production operation was used. Local reference checkout: `/Users/orkunozekin/Desktop/side-projects/soccer-team-builder`; it is optional research context, not a dependency needed to build this repository.

### Feasibility matrix

Evidence classes: **code-confirmed** means source exists; **executed** means the specifically named check ran; **doc-supported** means a primary source supports the mechanism; **prototype-needed** means device/emulator/domain proof remains required; **external gate** means organization policy, rights, or approval must be supplied. None means deployed or production-proven.

| Capability | Evidence and primary source | Implementation proof required before enabling |
| --- | --- | --- |
| Native sport surface | Existing coordinate concepts and 11 executed reference tests; [SDK 54 SVG](https://docs.expo.dev/versions/v54.0.0/sdk/svg/) supports SVG drawing. Code-confirmed, executed, doc-supported. | Step 2 renders soccer/basketball/football presets on both native platforms with long names, large text and narrow screens. Prototype-needed. |
| Native lineup editing | [SDK 54 gesture handler](https://docs.expo.dev/versions/v54.0.0/sdk/gesture-handler/) provides native gesture integration. Doc-supported; package absent. | Demonstrate drag versus scroll and accessible tap-to-place equivalent; persist and reload identical slots. Prototype-needed. |
| Atomic lineup/clock/slot updates | Existing callable imports; [transactions](https://firebase.google.com/docs/firestore/manage-data/transactions) and [callable authentication](https://firebase.google.com/docs/functions/callable). Code-confirmed, doc-supported. | Emulator tests with simultaneous coaches/claimants, duplicate request IDs and revoked roles. Prototype-needed. |
| Standings and score correction | [Match-outcome rules](https://www.theifab.com/laws/latest/determining-the-outcome-of-a-match/) illustrate sport outcome versus competition rules. No standings code exists. Doc-supported mechanism only. | Pure fixture corpus plus administrator-approved rules for each pilot; tied cohorts and correction rebuild tested. Prototype-needed, external gate. |
| Bracket progression | Transactional versioned records are supported by the database; no existing bracket engine. Doc-supported mechanism only. | Odd team counts/byes, tied knockout match, and correction after a descendant started must pass. Prototype-needed. |
| Playing-time ledger | Append-only domain events can use existing callables and transactional revisions. Code-confirmed infrastructure, doc-supported. | Replay equivalence, period/pause/resume, background suspension, corrections and overlapping football units tested. Prototype-needed. |
| Volunteer and ride privacy | Existing rules infrastructure; prior-phase guardian links are dependencies, not current code. | Rules and callable tests deny cross-household contacts; opt-in consent and cancellation rehearsed. Prototype-needed, external gate for transport policy. |
| Attendance/facility reporting | [Firestore aggregations](https://firebase.google.com/docs/firestore/query-data/aggregation-queries) support count/sum/average; complex rates require domain reducers. Doc-supported. | Hand-calculated denominator fixtures, correction rebuild, snapshot reproducibility and measured query cost. Prototype-needed. |
| Export | [SDK 54 FileSystem](https://docs.expo.dev/versions/v54.0.0/sdk/filesystem/) and [Sharing](https://docs.expo.dev/versions/v54.0.0/sdk/sharing/) support local file creation and native sharing. Doc-supported; packages absent. | CSV escaping/injection cases and both native share sheets, including cancel/no target. Prototype-needed. |
| Season rollover | Existing Admin SDK plus [retry guidance](https://firebase.google.com/docs/functions/retries) support resumable idempotent jobs. Code-confirmed infrastructure, doc-supported. | Crash/retry/source-change previews, role revocation and no copied privileges checked in emulator. Prototype-needed. |
| Drill resources | [Copyright Office FAQ](https://www.copyright.gov/help/faq/faq-fairuse.html) explains permission and case-specific limitations. | Original/commissioned/explicitly licensed content register and qualified coach age/safety review. External gate; no implied rights to competitor resources. |

All sources above were opened during planning on 2026-10-10. Expo's exact versioned SDK 54 reference was read. Primary documentation proves supported primitives, not the correctness of proposed domain algorithms. Do not present this plan as complete runtime proof; each gate has an owning step below.

## Shared contracts and entry gates

These are dependencies proposed in the companion Phase 1 and Phase 2 plans, not descriptions of today's schema.

- Keep top-level `/teams/{teamId}` and `/events/{eventId}`, with immutable `orgId`; teams also reference `programId`, `seasonId`, `divisionId` and events copy their authoritative hierarchy.
- Participants live at `/organizations/{orgId}/participants/{participantId}`; team roster at `/teams/{teamId}/roster/{participantId}`. All coaching and attendance identity is participant ID, never a guardian's uid.
- Organization membership is `/organizations/{orgId}/members/{uid}`; guardian links are `/organizations/{orgId}/participants/{participantId}/guardians/{uid}`. Private account participant links are not an organization directory.
- A canonical match has exactly one event and `teamIds` containing both same-organization sides; practices have one team. Legacy `teamId` stays a primary-team compatibility field. Never create one independent score per team's calendar event.
- Phase 2 events supply UTC `startsAt`/`endsAt`, IANA `timeZone`, `resourceId`/`facilityId`, `revision`, `publicationState: staged|published`, and lifecycle `status: scheduled|postponed|cancelled|completed`.
- Consume Phase 2 `/availability/{participantId}` with stored `yes|no|maybe` (missing response derives `unanswered`) and `/attendance/{participantId}` with `unknown|present|late|absent|excused` under the event. Publication roster eligibility and final `/events/{eventId}/rosterSnapshots/{participantId}` completion snapshots identify the denominator.
- Require versioned resource availability and closures for reproducible historical utilization. If only current intervals exist, Step 10 must add a report-source snapshot before reporting old periods.
- Use the Phase 1 web administration workspace for competition rules, bracket overrides, organization reports, and rollover; native coaches/households keep daily actions. Do not start a second web framework or separate authentication scheme in this phase.
- Recheck permissions server-side from current scoped memberships and guardian links. Phase 1 must provide a central capability resolver; add named capabilities there rather than embedding role-name checks in every callable.
- Step 1 cannot ship until prior-phase rules reject cross-organization reads/writes and canonical event/participant migration fixtures pass. A missing dependency is a recorded blocker, not permission to invent an incompatible parallel model.

## Proposed data and authorization design

All paths and interfaces in this section are **proposed and uncreated**. Every record has `schemaVersion`, authoritative scope IDs, server timestamps and revision where editable. Private and published documents are separate because document reads cannot selectively hide private fields.

| Proposed record | Key fields and lifecycle | Access |
| --- | --- | --- |
| `/events/{eventId}/coaching/{teamId}` | `sportPresetId`, preset version, roster snapshot reference, `slots[{slotId,participantId,x,y}]`, ordered bench IDs, `revision`, optional published view reference. | Assigned team coaching capability only; organization administrators need explicit coaching access, not reporting permission. |
| `/events/{eventId}/coaching/{teamId}/notes/{noteId}` | Author, participant reference if relevant, text, edited timestamp; never copied into publication/export/notifications. | Assigned coaching staff only; no guardian/player/team-membership fallback. |
| `/events/{eventId}/lineupViews/{teamId}` | Sanitized published slots and display labels, publication revision/time; no private notes or contact fields. | Relevant team viewers; coach explicitly publishes, retracts and republishes. Private is the default. |
| `/events/{eventId}/playSessions/{teamId}` | Period configuration, clock status, accumulated elapsed milliseconds, current period, running anchor timestamp, active units, latest sequence/revision, finalized flag. | Assigned coaching staff; mutations callable-only. |
| `/events/{eventId}/playSessions/{teamId}/actions/{operationId}` | Immutable `sequence`, `periodId`, `atElapsedMs`, actor, action kind, entering/leaving participant IDs, prior/correction action references. | Coaching staff read, backend-only write. No background timer writes every second. |
| `/organizations/{orgId}/competitions/{competitionId}` | Season/division/sport, participant team IDs, immutable published rules versions, active rules version, source revision, active calculation generation, state. | Competition managers configure; authorized league viewers see published summary. |
| `/organizations/{orgId}/competitions/{competitionId}/results/{eventId}` | Canonical event, explicit home/away team, nonnegative integer scores, outcome `played|forfeit|void`, proposed/final status, applied rules version, revision. | Assigned coaches propose; competition scorers finalize/correct with reason. |
| `/organizations/{orgId}/competitions/{competitionId}/resultHistory/{operationId}` | Before/after revision, reason, actor, event reference and server time. | Authorized competition staff; immutable backend writes. |
| `/organizations/{orgId}/competitions/{competitionId}/generations/{generationId}` | Source revision, rules version, ordered standings rows, tied cohort markers, bracket manifest reference, complete flag. | Viewers see only active complete published generation. Large output is paginated child records, not an unbounded document. |
| `/organizations/{orgId}/competitions/{competitionId}/bracketNodes/{nodeId}` | Round/seed inputs, source winner references, canonical event ID, state, revision and generation. | Published viewers; backend-owned progression. |
| `/events/{eventId}/volunteerSlots/{slotId}` | Team, kind, title, capacity, open count, public assignee display aliases, due time, revision. | Relevant households/team staff read; staff create; authorized adult claims via callable. |
| `/events/{eventId}/volunteerSlots/{slotId}/claims/{uid}` | Adult owner, status, operation ID, timestamps; sensitive details stored separately. | Own claim plus authorized staff; no child self-assignment to rides. |
| `/events/{eventId}/rideRequests/{requestId}` | Team, requester guardian, linked participant IDs, seats needed, coarse area, status. | Requesting household/staff; other guardians access a sanitized opt-in matching view, never the private record. |
| `/events/{eventId}/rideArrangements/{arrangementId}` | Explicit adult parties and confirmed participants, seats, cancellation state, contact-sharing consent version. | Parties and designated coordinators only; contact reveal callable rechecks links and consent. |
| `/organizations/{orgId}/reportRuns/{runId}` | Report/filter version, source cutoff/revisions, scope, numerator/denominator fields, missingness, computedAt, manifest and status. | Reporting capability; coaches restricted to assigned teams. No raw ride contacts or coaching notes. |
| `/organizations/{orgId}/rolloverJobs/{jobId}` | Source/target season, preview hash, selection/mapping manifest, state/checkpoints, counts, initiator. | Organization season managers; backend-only execution. |
| `/organizations/{orgId}/practiceResources/{resourceId}` | Sport, age range, objectives, duration, equipment, instructions, rights provenance, reviewer, version, draft/published/withdrawn. | Published resources to coaches; designated editors approve/withdraw. |
| `/events/{eventId}/practicePlans/{teamId}` | Ordered resource version references plus coach-authored duration/notes; explicit publication copy omits private notes. | Assigned coaches; optional sanitized household view. |

### Mutation and query interfaces

- All mutations use authenticated v2 callables with `{orgId, resourceId, expectedRevision, requestId, payload}`. `resourceId` is the relevant event/competition/job; typed client wrappers name the specific ID instead of a free-form path.
- Proposed callable names: `saveLineup`, `publishLineup`, `recordPlayAction`, `finalizePlaySession`, `proposeResult`, `finalizeResult`, `correctResult`, `saveCompetitionRules`, `publishBracket`, `correctBracket`, `claimVolunteerSlot`, `releaseVolunteerSlot`, `confirmRideArrangement`, `revokeRideConsent`, `requestReport`, `previewRollover`, `commitRollover`, `savePracticeResource`, `publishPracticeResource`, `savePracticePlan`.
- Return `{requestId, revision, state}`; backend-generated `operationId` identifies audit/jobs and asynchronous work also returns a job ID. Error codes distinguish invalid input, permission denial, stale revision, closed season, unsatisfied dependency and transient unavailable.
- Reuse Phase 1's supported callable transport error envelope and `details.domainCode` for domain failures; custom domain strings are not valid Firebase `HttpsError` transport codes.
- Deduplication key includes client `requestId`, operation type, actor and scope; reusing a key with a different payload is rejected. Transaction records the domain change, audit, dedupe result and outbox atomically. No external notification inside a retrying transaction callback.
- Validate event organization, each side's team/season/division, roster eligibility and current capability from trusted documents. A client-supplied scope or actor is never authority.
- Query the exact event subcollection for lineups/actions; roster fetch uses participant IDs from authorized team roster. Result listings use competition path plus status/event time, with deterministic pagination.
- Report queries use organization + season + time interval + permitted team/division; no unfiltered collection-group fallback if a scoped query fails. Carry required compound indexes in `firestore.indexes.json` and verify deployed indexes are enabled before feature enablement; emulator success alone is insufficient.
- Bound first-release competition computation to 256 teams and 4,096 final results per competition, bracket to 128 teams, reports to 366 days per run, rollover chunks to 100 target entities. Reject larger requests with an actionable partition instruction instead of silently truncating. These are engineering guardrails to revisit after measurements, not commercial limits.
- Job workers checkpoint pages, retry transient errors, and expose partial/failed states. Only a complete generation becomes active; reports never show partially computed rows as final.

## Domain rules and failure handling

### Sport surfaces, lineups, and playing time

- Versioned organization-approved presets describe surface, valid slots, unit name and maximum active participants. Start with soccer, basketball and football, with configurable small-sided/youth sizes. Do not infer a football variant or youth rules from free-text sport.
- Native surface uses `react-native-svg` for markings and native accessible marker controls; use `react-native-gesture-handler` only for editing. Install using Expo's version resolver. Keep tap participant → tap slot and list ordering as first-class alternatives to dragging.
- Save normalized coordinates, stable slot IDs and explicit bench order; clamp coordinates to surface bounds. Orientation transforms affect presentation only and must not rewrite persisted coordinates.
- Reject duplicate assignments within a unit, missing participant IDs and exceeded preset capacity. A roster departure marks the saved slot unavailable and asks the coach to replace it; never silently assign a different participant.
- RSVP and attendance are contextual labels; they never auto-replace a saved lineup. A coach can explicitly include an eligible unanswered participant with a warning.
- Football has independent offense/defense/special-teams units. A participant may appear in several units, but playing-time totals count the union of actual on-field intervals, not three simultaneous stints. Manual active-unit switching records who actually participated.
- Clock uses authoritative elapsed game time, explicit period starts/ends and pause/resume, not wall time since kickoff. Device backgrounding renders the current estimate from the last acknowledged clock anchor; it does not require an always-running JavaScript timer.
- `start`, `pause`, `resume`, `substitute`, `switchUnit`, `endPeriod`, `correct`, and `finalize` append a sequenced action. One transaction checks session revision, current active set and legal transitions; simultaneous coaches cannot both change the same revision.
- Closed-period corrections reference original actions and recompute derived intervals; raw actions remain immutable. Backdated changes require a reason and review of affected participants. No negative/overlapping same-participant intervals; final totals cannot exceed actual session duration.
- Live timer writes require online acknowledgment. Offline coaches can read the last acknowledged lineup/time state with stale labeling, but cannot claim a queued substitution is recorded. Optional local draft notes are scoped by account/org/event and cleared on logout; they are never merged silently into the ledger.
- Private notes and individual playing-time comparisons do not become family reports. First release exposes playing time to coaches only; any later participant/guardian publication needs a separate product permission decision.

### Results, standings, and brackets

- Coaches propose results; a designated scorer finalizes them. For a one-sided external-opponent game, the event may display a score but does not enter an internal competition unless an authorized competition team identity exists.
- Rules versions specify win/draw/loss points, allowed draws, forfeit awarded score/points, counted outcomes, and ordered supported tie-breaks: table points, tied-cohort head-to-head points, score differential, scores for, wins. Configurable score-differential caps apply per result before aggregation.
- Presets are drafts until a competition manager confirms actual league policy. No claim that one soccer/basketball/football standard dictates municipal standings; no automatic use of fair-play or opponent-strength criteria without input data and a defined algorithm.
- Head-to-head runs over the full tied cohort and applies only if every pair has the same positive number of finalized meetings; otherwise show that criterion not applicable. Apply the configured criteria to the original cohort in order, without recursive reapplication. Exhausted criteria yield a shared rank and explicit unresolved tie.
- Stable team ID orders presentation of tied rows only; it does not break the sporting tie. Bracket seeding blocks on unresolved ties until the manager records a reasoned seed override.
- Cancelled/postponed/unplayed matches do not add losses or zero scores. Voided results contribute nothing. Forfeits use explicit league policy and remain visibly marked. Finalizing a tied knockout game requires an explicit winner/decider permitted by the rules, not merely a larger guessed score.
- Each finalization/correction increments the competition source revision and appends immutable audit. A deterministic reducer rebuilds from canonical final results, then activates a generation only if its source revision still matches. Source changes during computation discard/retry the old build.
- During rebuild show the last complete generation with “updating” and source timestamp, not a mixed table. Workers are idempotent under duplicate/out-of-order triggers; a reconciliation job detects stale active generations.
- Single-elimination preview assigns explicit seeds and byes. A bye has no played event, score, attendance or facility demand. Published nodes reference canonical events; progression occurs only from finalized winners.
- Corrections before any affected descendant starts clear invalid downstream participants/results in a reviewed correction transaction/job. If an affected descendant has started or finalized, block automatic progression and require an administrator correction preview listing all invalidated nodes; do not silently rewrite played history.
- All bracket preview/commit operations require expected source and bracket revisions; locking publication prevents seeding from a stale table. Upstream history remains auditable, even when descendants are explicitly voided.

### Volunteers and rides

- Slots have explicit capacity, adult eligibility and claim/release deadlines. Transactional claim checks active claims and capacity, so two last-seat attempts produce one winner; retrying an operation returns the original outcome.
- Public assignment lists show the consenting adult's chosen display name/initials and responsibility only. Do not expose phone/email, other children's names, home addresses or private notes in slot documents.
- Ride requests use a coarse meeting area. Pickup addresses and contacts are revealed only between explicitly consenting adults in a confirmed arrangement through a current-authority callable; never include them in push text, exports or team chat previews.
- A verified guardian requests/consents for a linked child. Another guardian editing the same request sees its current revision and actor; unauthorized adults cannot add a child to their arrangement.
- Seat reservation and arrangement state commit together. Decline/cancel revokes future contact retrieval, frees capacity and notifies parties through Phase 2 outbox. Explain that already viewed/shared information cannot be recalled.
- This is coordination, not driver screening, insurance verification, custody adjudication or a safety guarantee. Keep rides disabled until the organization supplies its transport policy and responsible coordinator. Snack/setup/scorekeeping slots can ship independently.

### Reports and season rollover

- Attendance report eligible count comes from final closed-event participant eligibility snapshots. Exclude cancelled/postponed events; separate excused, unknown and missing records from absent. Preserve reports when a participant later transfers.
- Presence rate = `(present + late) / (present + late + absent)`; report excused, unknown, missing and eligible totals beside it. Completion coverage = `(present + late + absent + excused) / eligible`. A zero denominator renders “not enough data”, not 0%. RSVP response and attendance rates are separate metrics.
- Facility booked utilization = union of scheduled/completed published occupancy minutes intersected with resource bookable minutes / available bookable minutes for that resource and interval. Subtract closure/blackout intervals from availability; cancelled/postponed events contribute no booking time. Show conflicting minutes and bookings outside availability separately.
- Count the shared canonical game once, not once per team. Do not call booked utilization actual physical usage; attendance does not prove facility occupation. Report unknown availability separately instead of manufacturing a denominator.
- Resolve organization-local date boundaries and daylight-saving transitions to UTC intervals before interval arithmetic. Sum resource-minutes across resources, not an average of percentages; preserve source schedule/closure versions for reproducibility.
- Reports are versioned snapshots with generation time, source cutoff, filters, missingness and formula definitions. Corrections mark relevant snapshots stale and produce a new run rather than editing a previously exported report invisibly.
- Native export creates scoped CSV using SDK 54 FileSystem + Sharing; web export uses the existing administration workspace. Escape quotes/newlines and neutralize spreadsheet-leading formula characters. Default to aggregated operational data; participant-identifiable export requires explicit permission and confirmation.
- Rollover is preview then commit with a hash of selected source revisions. Create a new draft season and fresh team IDs linked via `previousTeamId`, copying selected program/division/team configuration only. Never mutate old season records.
- Staff assignments, participant team enrollments, guardian links, messages, scores, lineups, attendance, rides, waivers and payment obligations are **not** copied by default. Reuse existing organization participant IDs without reactivating relationships; future enrollment invites need separate review.
- Copying competition/practice templates creates draft versioned target records; no live bracket/results, published notifications or private coaching notes. Staff access in the target season is explicitly assigned through Phase 1 workflows.
- Rollover uses deterministic target IDs per job/source plus checkpoints. Retrying cannot duplicate teams. Source changes invalidate uncommitted preview; source archiving is an explicit separate action after target verification. Partial target season stays draft/hidden until complete.

### Practice resources

- Store original or commissioned instructional text and owned diagrams first; externally linked resources retain attribution and rights metadata. Do not scrape, reproduce competitor libraries, or download third-party videos into the app without permission.
- Rights register records owner, allowed uses, attribution, license URL/evidence, expiry and derivative restrictions. A missing/expired permission blocks publication and removes future resource selection; existing plans show a withdrawn-resource notice.
- Qualified organization reviewer validates sport, age band, equipment, duration and safety instructions; content claims do not become medical advice or certified coaching accreditation.
- Practice plan saves resource version snapshots so later edits do not silently change the event plan. Coach-authored private notes remain separate from any published household instructions.

## Numbered PR-sized implementation steps

Each numbered step is one `/implement-feature` invocation and one PR. Stop after its verification, screenshots when applicable, AI review feedback loop and Handoff update. Dependencies named below must have merged before work starts; no automatic implementation of the next step. If a step cannot fit a reviewable PR, split its checklist in this plan before coding and preserve the same acceptance boundary.

### 1. Lock contracts, pure domain types, and isolation fixtures

Depends on Phase 1 and Phase 2 shared contracts. Introduce typed phase contracts, scoped capability additions, canonical competition side identity and pure validators without enabling UI. Add emulator fixtures for two organizations, two guardians, coach/parent, revoked coach, two teams sharing one event and archived season. Add deny-by-default rules for new paths. Verify cross-tenant/private reads, immutable scope, no uid-as-participant assumptions and stale operation rejection. Exit: backend test harness runs with explicit emulator project/hosts and no production fallback. UI evidence not applicable.

### 2. Prove native surfaces and accessible slot interaction

Depends on 1. Install SDK-compatible SVG/gesture dependencies and build development clients. Add internal development-only surface harness with soccer/basketball/football preset selection, long names, 30 roster entries and tap/list editing. Test normalized coordinate round-trip and unit capacity. Inspect iOS and Android captures for narrow/landscape/large-text state, drag/scroll conflict, selected marker and alternate list mode. Record frame/interactivity observations on actual simulator/device; do not claim physical-device performance from simulator. Exit: no clipped labels or inaccessible drag-only actions; otherwise keep feature hidden.

### 3. Persist private saved lineups and optional publication

Depends on 2. Add `saveLineup`/`publishLineup`, separate private notes/public views, client wrappers and event/team-scoped screens. Test save/reload bench order, simultaneous editors, roster departure, revoked coach, guardian denial of notes, publish/retract and offline error. Capture private editor, published family view, empty roster and conflict recovery. Exit: every participant appears at most once per unit, private notes absent from public payloads and saving never relies on RSVP ordering.

### 4. Add playing-time ledger and clock transitions

Depends on 3. Implement pure action reducer and `recordPlayAction`/`finalizePlaySession`; derive per-participant intervals from immutable actions. Test substitutions at identical timestamps, period breaks, paused clock, background resume, duplicate command, stale coach revision, correction and overlapping football units. Capture running/paused/finalized/correction and offline-write-blocked screens. Exit: replay produces identical totals and audit, every participant total is bounded by measured game duration, no timer-driven write loop.

### 5. Configure competition rules and propose/finalize results

Depends on 1. Add versioned rules, rule validation, canonical side mapping, result proposal/finalization and correction history; add web competition setup and native score proposal UI. Supply table fixtures for draws/forfeit/void/cancelled/external opponent and unauthorized scorer. Capture rules confirmation, pending proposal, final score, correction reason and invalid knockout draw. Exit: pilot manager-approved rules fixture exists; no implicit standard assigned from a sport name.

### 6. Publish reproducible standings and correction generations

Depends on 5. Implement pure reducer, immutable calculation generations, worker checkpoint/revision activation and reconciliation. Test a three-way tie, incomplete head-to-head, capped differential, equal records, duplicate triggers and correction racing rebuild. Compare fixture results against hand calculations and randomized replay order. Capture completed table, shared-rank tie and updating/stale state. Exit: no mixed generations, stable presentation does not resolve sporting ties, capped-size load probe records duration/read counts.

### 7. Add single-elimination previews and safe correction

Depends on 6 and Phase 2 event publication service. Generate seed/byes preview, canonical event linking, winner progression and administrator correction previews. Test 3/5/8 teams, unresolved seed tie, delayed result, tied knockout, duplicate progression and corrected winner with started descendants. Capture preview, published bracket, bye, unresolved winner and blocked correction. Exit: byes create no phantom attendance/booking; stale preview cannot publish; descendant invalidation requires explicit audited confirmation.

### 8. Deliver volunteer slots and assignment privacy

Depends on 1 and Phase 2 targeted outbox. Add staff slot setup, transactional adult claims/releases and sanitized assignment views. Test last-slot contention, duplicate commands, repeated releases, revoked adult eligibility, canceled event and public/private payload separation. Capture open/full slots, own assignment, concurrent claim loss and cancelled assignment states using synthetic data. Exit: capacity cannot be exceeded, public documents contain only consented display aliases, and no private contact appears in logs or notifications. Ride coordination is a separate step and is not part of this PR.

### 9. Deliver gated private ride coordination

Depends on 8 and current Phase 1 guardian links. Add private ride requests/arrangements, explicit adult consent, transactional seat reservations, party-scoped contact retrieval and cancellation/revocation notifications. Keep the capability disabled until the organization transport policy and coordinator gate are recorded. Test last-seat contention, duplicate confirmation, guardian unlinking between request and confirmation, multiple-guardian stale edits, consent revocation, canceled event and contact-access denial for unrelated households. Capture opt-in discovery, consent, confirmed/cancelled arrangements, capacity conflict and contact unavailable states using synthetic contacts. Exit: contact retrieval rechecks current authority/consent, no pickup/contact details appear in public records or push payloads, and enabling remains blocked without external policy evidence.

### 10. Add operational report reducers and snapshot jobs

Depends on 1 and completed Phase 2 attendance/resource contracts. Implement immutable source snapshots where necessary, presence/coverage formulas, facility interval union and report job/rebuild flow. Test missing versus unknown, excused, roster transfers, canonical shared games, overlapping bookings, closures, DST and zero availability. Use a hand-calculated corpus and a synthetic 366-day scoped run to record cost/duration. Capture web reports with missingness/stale/error states and native scoped summary. Exit: denominators are visible and auditable; actual-use claims absent.

### 11. Add scoped CSV exports and native sharing

Depends on 10. Add SDK-compatible file/sharing packages and explicit export capability checks, versioned CSV headers and aggregate-first export UI. Test commas/quotes/newlines, formula-leading cells, unauthorized team filters, zero rows, file cleanup and canceled share flow. Capture both native share sheets and web download confirmation. Exit: generated files match the report version/filter; temporary exports are scoped and cleaned, and youth/contact/private-note data is excluded by default.

### 12. Deliver resumable season rollover

Depends on 1; optional copy adapters for competition/resources depend on 5/13 and remain unavailable until those land. Implement preview/hash/commit, deterministic target mapping and chunked checkpoint jobs. Test 201 source teams with forced crash after first chunk, retry, source edit, permission revocation, failure visibility and archived-source reading. Capture preview exclusions, changed-source rejection, partial progress and completed draft season. Exit: history unchanged, counts reconcile, no inherited staff/enrollment/guardian permissions or notifications.

### 13. Deliver rights-cleared practice resources and event plans

Depends on 1 and Phase 2 practices. Add content/version/rights register, editor/reviewer workflow and coaching plan editor. Seed only original synthetic resources until rights and reviewer gates are satisfied. Test age/sport filters, expired license, withdrawal, stale editor, version snapshots and private-note publication exclusion. Capture resource list, age-filtered empty state, approval/withdrawal and saved practice plan. Exit: every published resource has rights evidence and a reviewer; no competitor content copied.

### 14. Pilot readiness, operational probes, and phase acceptance

Depends on 3–13; rides may remain disabled under a documented external gate, but that is explicitly an incomplete ride capability, not full phase acceptance. Run a synthetic multi-organization season rehearsal: lineup → timed substitutions → result correction → standings/bracket correction → attendance reports → rollover. Measure worker latency, stale-generation recovery, report read cost, exports and authorization after role revocation. Capture latest affected native/web states and run accessibility review. Exit: acceptance checklist below passes or an exact remaining gate is documented; enabling production flags follows authorized release procedures.

## Proposed code organization and migration

Existing integration points: [`src/types/models.ts`](../../src/types/models.ts), [`src/screens/EventDetailScreen.tsx`](../../src/screens/EventDetailScreen.tsx), [`functions/src/index.ts`](../../functions/src/index.ts), [`firestore.rules`](../../firestore.rules), [`firestore.indexes.json`](../../firestore.indexes.json), and [`package.json`](../../package.json). Preserve current navigation/auth behavior while adding entry points through the prior-phase scope resolver.

Proposed uncreated modules, not clickable source claims: `src/lib/coaching/` for sport presets/lineup/playtime reducers; `src/lib/competition/` for standings/bracket algorithms; `src/lib/reports/` for interval/denominator reducers; corresponding `src/api/` wrappers, native screens and prior-phase web routes; `functions/src/coaching/`, `competition/`, `volunteers/`, `reports/`, `seasons/`, `resources/` for trusted services. Pure domain modules must be reusable in backend tests without importing Firebase client initialization.

- No retroactive score, lineup, attendance or playing-time inference from legacy events. Old event views remain usable and show unsupported actions unavailable until canonical schema migration.
- Deploy rules and indexes plus callable validation before clients exposing writes. Enable capability flags independently: coaching, results, brackets, volunteers, rides, reports, rollover and resources. Flags do not replace authorization.
- Reuse prior-phase audit/outbox/jobs rather than inventing competing implementations. Logs contain operation IDs, resource IDs, counts, error class and timing; no private notes, contacts or raw CSV bodies.
- Roll back by disabling entry points/new writes and retaining source/history; never delete immutable ledger/audit or prior-season data to make rollback easier. Recompute faulty derived tables from preserved sources after fixing reducer versions.

## Acceptance and validation record

- [ ] All documented dependency contracts actually exist and cross-organization/private-access fixtures pass against emulators.
- [ ] Soccer/basketball/football lineups preserve normalized positions, bench order and unit membership after save/reload; tap/list alternative works with screen reader/large text.
- [ ] Private notes and individual playtime remain inaccessible to households and unauthorized staff; public lineup publication is explicit.
- [ ] Clock/background/corrections replay deterministically; duplicate commands and simultaneous editors do not double-count or overwrite.
- [ ] Results and configured rules reproduce standings; unresolved ties remain visible; score corrections and worker retries converge on one active complete generation.
- [ ] Brackets use canonical events and safely block/correct affected descendants; no bye becomes a false game/absence.
- [ ] Volunteer capacity holds under contention; rides expose contacts only to consented parties and stay disabled without organization policy.
- [ ] Attendance missingness and facility booked-minute formulas match hand calculations, including DST, closures and shared games.
- [ ] Exports preserve filters/version and neutralize CSV formula injection without exposing restricted records.
- [ ] Rollover preview/retry preserves history and does not carry stale permissions, enrollments, guardians or messages.
- [ ] Every published practice resource has verified rights and age/safety review; withdrawn resources cannot be newly assigned.
- [ ] Each UI PR embeds inspected screenshots accessible to reviewers from its latest checkout, with captions and required empty/error/conflict states.
- [ ] Required tests/typecheck and backend build pass per step; CI and configured AI review feedback are addressed using `address-pr-feedback`, followed by a new bot-tagged re-review comment after fixes. Missing reviews are reported, not treated as approval.

Executed during planning: the 11 reference geometry/marker tests described above. No Phase 3 application code, native screenshots, Firestore emulator integration, worker load probe or pilot operation has run. Every unchecked acceptance item remains future work. Planning validation must check document links and contract consistency; application tests belong to implementation PRs.

## Handoff

### Done so far

- Inspected native types, event reads/writes, current rules, role helper, callable infrastructure and dependency versions.
- Inspected owner's soccer pitch layout/marker source read-only and executed 11 bounded reference tests successfully.
- Read exact SDK 54 reference and primary documentation for rendering, gestures, transactions, callables, jobs, aggregation, export, sporting outcomes and rights limitations.
- Coordinated canonical event/attendance contracts with Phase 2; recorded proof classes and explicit runtime/external gates.

### Remaining work

Not started. Begin **Step 1 only**, confirm Phase 1/2 merged contracts, implement its isolated PR, update this document with exact checks/evidence and next incomplete step. Each later explicit “implement the next step” request selects the next numbered incomplete step, not the whole phase.

### Blockers and risks

- All Phase 3 domain modules and runtime proofs are unimplemented; prior-phase dependencies must land first.
- Native drag/scroll/accessibility and package rebuild require simulator/device proof; source/reference tests are insufficient.
- Pilot league rules, transport policy, rights evidence and qualified content reviewer are external gates owned by the organization/product owner.
- No production credentials/data/notifications are authorized by this plan; development uses non-sensitive emulator fixtures. Business model selection remains pending.

### Pointers for the next agent

Read the product plan, Phase 1/2 plans and repository instructions before Step 1. Use current scoped capabilities and participants, preserve canonical event IDs, and keep private/public documents separate. Record test commands, source revisions, real screenshots and remaining gates in the step PR and Handoff. Leave merging to the user.
