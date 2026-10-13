# Phase 1: Organization, household, and season foundations

## Status

| Field | Value |
| --- | --- |
| Status | in-progress |
| Last updated | 2026-10-12 |
| Implementation | Steps 1–9 and invitation refinements merged, verified against remote main at `0e589c8` on 2026-10-12. Step 10 household agenda and native filters implemented and locally validated on `codex/phase-1-household-agenda`; [PR #16](https://github.com/orkunozekin/team-hangout/pull/16) is open with passing CI and AI review pending. Steps 11–15 remain incomplete. |
| Related PR | Step 9 [PR #14](https://github.com/orkunozekin/team-hangout/pull/14) and invitation refinement [PR #15](https://github.com/orkunozekin/team-hangout/pull/15) merged. Step 10 [PR #16](https://github.com/orkunozekin/team-hangout/pull/16), branch `codex/phase-1-household-agenda`, open for review. |
| Product approval | Phase 1 capabilities approved; technical choices below are implementation defaults, not deployed behavior. |
| Commercial approval | **Business model selection pending.** No prices, fees, ads, or entitlement restrictions are enabled by this plan. |

Execution index and baseline checks: [phase plans](../plans/phase-plans.md). Parent: [approved product plan](../plans/product-plan.md). Research: [anonymized competitive context](../research/competitive-context.md). Dependencies: [Phase 2 operations](phase-2-league-operations-feature-plan.md) and [Phase 3 coaching](phase-3-coaching-competition-feature-plan.md) consume these foundations. Later phases consume the contracts established here; they do not authorize implementing later capabilities in a Phase 1 PR.

## Goals and scope

- Model municipal/community-center and private-club organizations, program hierarchies, season archives, scoped staff, independent participants, and separately authenticated guardians.
- Preserve existing authentication, teams, events, invitations, and account deletion through an explicit, resumable migration.
- Deliver native household navigation and calendars plus a web workspace for bulk administration, invitations, and reviewed imports.
- Offer revocable calendar subscriptions, accessible core workflows, and essential email information without requiring installation of the native app.
- Establish tested tenant isolation and server-owned authority before inviting youth households.
- Out of scope: RSVP writes, attendance, automatic league scheduling, closures, chat, push delivery, lineups, competition results, registration, billing, and monetization. Their identifiers and boundaries must remain compatible with later phases.
- Do not infer that two children with matching names are one person or that an adult sharing an email address is a guardian.

## Current state and evidence boundaries

Baseline inspected: `d66e89be156fec98d9cd58a689384a214ccdd81e`. Local source inspection proves the implementation shape, not deployed production configuration or successful store distribution.

| Existing evidence | Finding and implementation consequence |
| --- | --- |
| [Models](../../src/types/models.ts), lines 1–64 | Team membership equals a login account; no organizations, independent participants, or guardians. Add separate records rather than widening `userId` to mean a child. |
| [Team persistence](../../src/firebase/teams.ts), lines 151–258 | Clients create teams, invitation lookups, and coach membership, then join through public code lookup. Replace authority-changing writes with authenticated server commands. |
| [Rules](../../firestore.rules), lines 60–105 | Any signed-in account can get a team; self-created coach membership is accepted without proof of team ownership. Close these paths before tenant rollout. |
| [Event persistence](../../src/firebase/events.ts), lines 91–123 | Calendar fetches one team's events and stores separate `date`/`time`. Introduce canonical instants and aggregate authorized teams. |
| [Schedule screen](../../src/screens/ScheduleScreen.tsx), lines 69–125 | Screen props require one team and membership; household view needs a new context and query boundary. |
| [Native Firebase initialization](../../src/firebase/config.ts), lines 18–49; [authentication](../../src/api/auth.ts), lines 15–26 | Native persistence and native sign-in imports prevent treating the existing `web` script as proof of a working admin website. Use a separate browser initializer and app. |
| [Account deletion](../../functions/src/index.ts), lines 27–86 | Only `users` and matching `teamMembers` are removed; teams/events remain. New grants, subscriptions, and projections require explicit cleanup. |
| [Function package](../../functions/package.json), [deployment config](../../firebase.json) | Node 22 callable backend exists. Hosting, email transport, task workers, storage import objects, and emulator test configuration do not exist yet. |
| [Indexes](../../firestore.indexes.json) | Only existing event/member indexes are declared. Every new filtered query needs a checked-in index or documented single-field sufficiency. |
| [Scaffolding decisions](../../QUESTIONS.md), lines 9–17 | Earlier client-only backend and web exclusions are superseded where this approved phase requires server authorization and a web workspace. |

Research reviewed official SDK 54, React Native 0.81, Firebase, Vite, and calendar specification documentation on 2026-10-10. The coordinating agent ran baseline client typecheck and 13 existing suites/93 tests successfully under Node 26.3.0, and a compile-only Functions check under Node 24 after bypassing the declared Node 22 engine check; see the index for commands and limits. Existing tests mock backend services and do not prove new authorization. No new feature runtime prototype, device test, backend deploy, email send, or migration was run while writing this plan. The evidence matrix distinguishes documentation support from proof still required.

## Architecture and canonical contracts

### Runtime boundaries

- Keep the Expo SDK 54 native application and Firebase project; do not copy production data or credentials from another app.
- Use a separate `admin/` React + TypeScript + Vite browser app, served as static files through Firebase Hosting. These paths are proposed and uncreated.
- Browser authentication initially supports existing email/password accounts. Native provider users can use a verified password-reset/account-linking flow with the same account; never create an email-matched duplicate UID. Adding browser provider sign-in is optional after the core admin path works.
- Share pure schemas, enums, serializers, authorization fixtures, and API contracts in proposed `shared/`; do not share native components or native Firebase bootstrap with the browser.
- Keep browser routing small: organization picker, program/season/division lists, team roster, invitations, import jobs, account/help. A direct URL must reauthorize after login and must not trust organization IDs in route state.
- Use callable Functions for all authority changes, hierarchy writes, invitation acceptance, imports, feed management, and account deletion. Server Admin SDK bypasses Firestore rules, so handlers must independently authorize and validate every referenced record.
- Establish one server-side capability resolver shared by all handlers. It derives named capabilities from current organization/program assignments, team coaching/captain assignments, and participant/guardian grants; it never trusts projected roles or client-supplied capabilities. Later phases extend this resolver and its actor matrix instead of adding divergent role checks.
- Permit direct Firestore reads only for narrow, tested, tenant-scoped resources. Household aggregation uses callable reads that recheck live grants; large aggregate access must not depend on a client passing a list of supposedly authorized teams.
- Do not deploy experimental SDK packages. Install native dependencies through `npx expo install` and confirm the SDK 54 dependency graph before application changes.

### Common representation

All new stored records have `schemaVersion: 2`, server `createdAt`/`updatedAt`, and `createdBy`/`updatedBy` where a person caused the mutation. Mutable records also have a monotonic integer `revision`, incremented by their server command and checked against `expectedRevision`. Store timestamps as Firestore Timestamp; use ISO strings in callable JSON and Date only in client view models. IDs are opaque generated IDs, never names, email addresses, or dates of birth. All commands carry `requestId` for retry deduplication and return stable error codes and field errors.

| Path | Required fields and meaning |
| --- | --- |
| `organizations/{orgId}` | `name`, `kind: municipal|communityCenter|club`, `timeZone` (IANA), `status: active|archived`, `schemaVersion`. No public directory in Phase 1. |
| `organizations/{orgId}/members/{uid}` | `roles: (orgAdmin|programStaff)[]`, `programIds: string[]`, `status: active|revoked`, grant/revocation audit fields. `orgAdmin` covers all programs; program staff covers only enumerated programs. |
| `organizations/{orgId}/programs/{programId}` | `name`, `sportCode: soccer|basketball|football|other`, optional `sportLabel`, `status: active|archived`. A program is the league grouping in Phase 1. |
| `organizations/{orgId}/seasons/{seasonId}` | `programId`, `name`, `startsOn`/`endsOn` local ISO dates, `status: draft|active|archived`. Dates do not establish access or remove historical records. |
| `organizations/{orgId}/divisions/{divisionId}` | `programId`, `seasonId`, `name`, optional age-band label, `status`. Validate that all parent records belong to the same organization. |
| `teams/{teamId}` | Existing fields retained; add immutable `orgId`, `programId`, `seasonId`, `divisionId`, `status: active|archived`, `schemaVersion`. Move between organizations only through a future reviewed migration. |
| `teamMembers/{teamId_uid}` | Keep existing `teamId`, `userId`, `role` during compatibility. Add `orgId`, `roles: (coach|captain)[]`, `status`, scoped grant audit fields. Actual participant enrollment lives in roster, not here. |
| `organizations/{orgId}/participants/{participantId}` | `displayName`, `kind: youth|adult|unknown`, nullable `linkedUserId`, optional `externalId`, `status: active|archived`, `schemaVersion`. `linkedUserId` means the participant's own account only. |
| `organizations/{orgId}/participants/{participantId}/private/profile` | Optional birth date, guardian contact details, and staff-only operational notes needed for onboarding. Do not embed these in team roster or calendar payloads. New collection is server-only initially. |
| `organizations/{orgId}/participants/{participantId}/guardians/{uid}` | `status: active|revoked`, `permissions: {viewSchedule, respond, viewProfile, editProfile}`, `grantedBy`, `grantedAt`, nullable `revokedAt`. `respond` is reserved for Phase 2; Phase 1 does not implement RSVP. |
| `teams/{teamId}/roster/{participantId}` | `orgId`, `participantId`, `status: active|removed`, nullable `jerseyNumber`, `joinedAt`, nullable `removedAt`. Validate participant and team organization equality. |
| `users/{uid}/organizationLinks/{orgId}` | Server-owned discovery pointer: `orgId`, `status`, relationship summary and source revision. Resolve live membership/guardian/self relationships before returning organization data. |
| `users/{uid}/participantLinks/{orgId_participantId}` | Server-owned self-only pointer: `orgId`, `participantId`, `relationship: self|guardian`, `status`. Not a source of authorization and no other household data. |
| `users/{uid}/teamAccess/{teamId}` | Server-owned self-only navigation projection with `orgId`, source link identifiers, `status`, `revision`. Useful for discovery; all sensitive server reads revalidate canonical grants. |
| `users/{uid}/agenda/{eventId}` | Reserved server-owned agenda projection: `orgId`, `teamIds`, minimal event summary, `sourceVersion`. Not directly readable in Phase 1; aggregation callable reauthorizes and drops stale rows. |
| `events/{eventId}` | Existing event ID retained; immutable `orgId`, `programId`, `seasonId`, nullable `divisionId`, `teamIds`, non-null legacy primary `teamId` equal to `teamIds[0]` (teamIds has at least one entry), `startsAt`, `endsAt`, `timeZone`, `status: scheduled|postponed|cancelled|completed`, independent `publicationState: staged|published`, nullable `publicationOperationId`, integer `revision`, `deletedAt`, `schemaVersion`. |

`roles` notation in this table denotes arrays, for example `['coach', 'captain']`; do not invent string values containing brackets. A user may have organization, team, guardian, and self-participant relationships simultaneously.

### Participant and household identity

- A participant belongs to exactly one organization. A child attending two organizations has two organization-local participant IDs, joined only in the guardian's private view.
- No global household directory or cross-organization child identifier is introduced. The native household calendar means “the participants and teams this signed-in account can currently access.”
- Staff cannot search a global user directory, enumerate a user's other organizations, or see the other organization's participant IDs. Participant email addresses are not public roster fields.
- A guardian link requires organization-authorized invitation/approval. A guardian may request a second-guardian invitation; an administrator approves it. Existing guardians cannot silently grant arbitrary new adults access.
- A youth profile does not gain an Auth account by import or guardian acceptance. Adult self-linking requires an organization invitation or staff confirmation; matching names or contact email alone is insufficient.
- Default guardian rights are viewSchedule/viewProfile; explicit organization configuration enables editProfile. Phase 2 may enable respond for active links. Revocation applies to every right immediately on canonical reads.
- Show the acting account and selected participant name on every edit confirmation. Household participation does not confer coach privileges.

### Authorization matrix

| Actor | Read scope | Write scope |
| --- | --- | --- |
| Organization admin | Own organization hierarchy and approved participant details | Own hierarchy, staff grants, participant/guardian approvals, archive, imports; cannot promote platform super admins. |
| Program staff | Explicit assigned programs and their teams/rosters | Manage assigned program data and imports; cannot grant orgAdmin or access other programs. |
| Coach/captain | Assigned teams, roster display data, published events | Team details within assigned role; no guardian approval or private birth/contact data by default. |
| Guardian | Linked participant profile according to permissions, published events for enrolled teams | Approved profile fields only; no roster/hierarchy writes or staff notes. |
| Self-linked participant | Own approved profile and published enrolled-team events | Own approved contact/profile fields only. |
| Unrelated authenticated account | Own account and non-sensitive invitation acceptance result | No tenant data writes or invitation enumeration. |
| Platform administrator | Existing platform support surface pending explicit support policy | No silent impersonation. Future support reads use explicit server authorization and audit logging; normal organization UI does not synthesize coach rights from platform role. |

Replace permissive existing rules with explicit field allowlists and immutable tenant references. `users/{uid}` self edits allow only displayName and selected UI preferences; prevent writes to `appRole`, access projections, account state, or organization pointers used for authorization. Existing super-admin tools remain separate and must be tested, with no bypass that leaks participant data into the normal household experience.

### Query and command contracts

- `listMyOrganizations({cursor?, pageSize<=50})`: derives relationships for caller; returns names and role summaries only, not another household's links.
- `listOrganizationHierarchy({orgId,programId?,seasonStatus?,cursor?})`: authorizes org/program scope and returns paginated hierarchy. Direct admin reads, if used, query the explicit organization's subcollection and use the same policy tests.
- `listRoster({orgId,teamId,cursor?})`: returns participant display names and roster fields only; staff private profile requires a separate authorized command.
- `listHouseholdAgenda({from,to,participantRefs?,teamIds?,eventTypes?,cursor?,pageSize<=100})`: derive accessible participant/team set server-side; supplied filters only narrow it. Initial date window is at most 93 days; cursor contains server-validated ordering state.
- Agenda queries use `orgId ==`, `teamIds array-contains teamId`, `deletedAt == null`, `publicationState == published`, and `startsAt >= from`, `< to`, ordered by startsAt then document ID. Query authorized teams individually in bounded concurrency, deduplicate by event ID, and attach only the caller's relevant participant labels.
- Do not issue unbounded `in` lists or assume Firestore rules filter inaccessible documents. Add matching composite indexes and verify in staging: the emulator does not prove production index readiness.
- `createOrganization`, `saveHierarchyEntity`, `saveTeam`, `setStaffAssignment`, `saveParticipant`, `setRosterEnrollment`, `approveGuardian`, `revokeGuardian`, and `archiveSeason` run on the server; validate all references and expected revision before mutation.
- `expectedRevision` protects user edits from lost updates. Return `conflict` plus current revision and safe changed-field summary; UI offers reload rather than silent overwrite.
- `requestId` is scoped by caller + operation + organization; an existing successful command returns its original result. Reusing a key with a different normalized payload returns `conflict`.
- Use supported callable transport errors: `unauthenticated`, `permission-denied`, `not-found`, `invalid-argument`, `failed-precondition`, `already-exists`, `aborted`, `resource-exhausted`, or `unavailable`. Carry typed domain errors such as `STALE_REVISION`, `ACCESS_REVOKED`, or `REQUEST_ID_REUSED` in `details.domainCode`, with safe field errors where appropriate. References to “conflict” describe the domain outcome, not a Firebase `HttpsError` code; use `aborted` or `failed-precondition` plus the domain detail. Unauthorized cross-org ID lookups return a non-disclosing result. All later phases reuse this envelope.
- Phase 1 calendar reads require `publicationState == published` and exclude deleted/cancelled/postponed events by explicit lifecycle checks. Phase 1 uses these separate lifecycle/publication fields from the outset but exposes only ordinary scheduled events; Phase 2 adds lifecycle controls and cancelled/postponed history presentation without replacing event IDs. When `publicationOperationId` is non-null, readers also require that operation to be committed; Phase 1 single-event publish/import commands may leave it null, while Phase 2 introduces fenced multi-event publication.

## Migration, compatibility, and deletion

### Reviewed migration procedure

1. Generate a read-only inventory of teams, creators, memberships, invite lookups, and event references using the app's own authorized development/staging backend. Never use unrelated database connectors. Document whether any deployed users exist before running a live migration.
2. Build an explicit mapping manifest `{teamId,orgId,programId,seasonId,divisionId,timeZone,confirmedBy}`. Do not guess city/club ownership from a creator UID, name, email domain, or coach role.
3. For unmapped teams retain the legacy experience behind a compatibility path with tightened rules; show “organization setup required” to authorized managers. Never place all unmapped records in a shared default organization.
4. Map every legacy player membership to an organization-local participant linked to that same UID. Coaches do not automatically become players; preserve coach assignments separately. Preserve duplicate memberships across teams as one participant only when the same UID and organization establish identity, retaining all roster links.
5. Preserve all legacy IDs and timestamps; add versioned fields. Backfill events with manifest timezone and an explicitly reviewed default duration where no end time exists. Mark `timeSource: legacyConverted` and `durationSource: migrationDefault`; unresolved or ambiguous local times require review before household publication.
6. Set `teamIds: [teamId]`, retain `teamId`, derive hierarchy from the mapped team, and preserve soft deletion. Build startsAt from the local calendar date plus `time`, not by applying timezone conversion twice to the legacy Date.
7. Run dry-run counts and per-record validation; store a checkpoint and manifest checksum. Apply bounded batches using deterministic target IDs and migration marker `migrationRunId`; rerunning a completed batch must not duplicate roster/participant records or emails.
8. Resolve existing invite codes through the server while preserving code strings. Legacy codes allow team join request/self enrollment according to existing intent; they never approve guardian access to a named child or staff elevation. New target-specific invitation contracts are separate.
9. Reconcile counts, timestamps, orphan references, and representative access tests. Record unresolved teams and blocking invalid times. Do not claim “migration complete” because a script exited successfully.
10. Deploy expanded readers and server commands before restrictive cutover. Maintain dual-read compatibility during rollout, then deny legacy authority writes. Old binaries receive an actionable update-required error; preserving data does not require preserving unsafe old-client writes.
11. Remove legacy write adapters only after staging and pilot reconciliation; retain reversible mapping/audit data according to an approved retention policy. Rollback disables new UI flags and restores read compatibility; never reopen insecure writes.

### Account deletion contract

- Preserve the existing `deleteAccount` callable name and client result fields while adding job status where needed. Require recent authentication for the expanded destructive operation and disable authority before asynchronous cleanup.
- Create a resumable `accountDeletionJobs/{uid}` marker server-side. Mark the account as deleting; every callable checks that state. Cancel pending invitations to this account, revoke feeds, and remove its staff/team grants, guardian links, private projections, and notification endpoints.
- Keep organization-owned events, teams, roster history, and other guardians' access. Deleting a parent account does not delete a child profile or imply consent to remove another guardian.
- Unlink `linkedUserId` on self-linked participants; remove account-owned contact data, preserve operational participant identity only under the organization's approved retention policy, and pseudonymize where required. Final youth retention/legal policy is an external launch gate, not settled by this plan.
- Do not block account deletion indefinitely because the user is the last org admin. Warn beforehand, archive administrative control and route recovery to audited support; deny orphan privilege acquisition. Staff handover is preferred but cannot become a forced account-retention condition.
- Revoke callable/feed access first, clean bounded pages, then delete Auth user. Retry partially completed deletion without relying on the deleted account being able to authenticate again; worker/service identity resumes from durable status.
- Deletion does not retrieve calendar entries or emails already copied to another application. Explain this limitation clearly.

## Invitations and import design

### Guided invitations

- Store private `organizations/{orgId}/invitations/{invitationId}` records with target participant/team, intended relationship, approved rights, normalized recipient email, expiry, status, inviter, acceptedBy/At, and revokedAt.
- Generate high-entropy random invitation tokens, store only a cryptographic hash in server-only `invitationTokens/{tokenHash}`. A link token is never logged, placed in analytics, or stored in a PR screenshot.
- New invitations expire after seven days by default, can be revoked/resend-rotated, and are accepted once transactionally by the intended verified email account. Different account email prompts a safe switch/recovery flow; email equality does not replace invitation validation.
- Show non-sensitive expired/used/revoked states and a request-help route. After login resume acceptance, but clear pending tokens on logout/account switch and do not autoaccept without confirmation.
- Support app links and an HTTPS browser acceptance fallback. Existing custom-scheme parsing uppercases codes, so new opaque tokens need a separate parser; do not send them through the legacy code normalizer.
- Invitation status differentiates created, queued, accepted by mail transport, failed, accepted by user, expired, and revoked. Transport acceptance never means the person read the message.

### CSV preview and commit

- Phase 1 imports are CSV only. Downloadable versioned templates distinguish participants/rosters from schedules; do not promise arbitrary vendor exports or spreadsheet parsing.
- Browser parses a preview for fast feedback; server independently parses and validates the canonical uploaded bytes. Use UTF-8, header mapping, quoted fields/newlines, and BOM support; cap first version at 5 MB and 5,000 rows per job. Return actionable limit messages rather than truncating.
- Proposed private Storage location `imports/{orgId}/{jobId}/source.csv`; authorize upload by caller org/program scope, deny public access, and delete source/row data after an explicitly configured retention interval (initial operational default seven days, subject to privacy review).
- Server import job includes `kind`, templateVersion, fileChecksum, ownerUid, orgId, status, validatedAt, mappingHash, previewRevision, counts, expiresAt and commit checkpoint. A server-only job token binds a confirmed preview to exact bytes, mapping, target season, and policy revision.
- Participant columns: externalId (recommended), participantName, kind, teamExternalId, optional guardianEmail1/guardianEmail2. Private birth/contact columns are optional and permission-gated; do not require birth date merely to join a team.
- Schedule columns: externalId, teamExternalId, eventType, title, localDate, localStartTime, localEndTime, timeZone, locationName, address, notes. Require explicit valid date/time/zone; reject ambiguous/nonexistent daylight-saving times unless the row supplies a validated offset.
- Duplicate hierarchy: same scoped externalId is an update candidate; exact repeated source rows are duplicate errors; same normalized name without a trusted ID is a review candidate, never an automatic merge. Guardians use explicit invitation consent and never become active links from an uploaded email.
- Each preview row has source row number, normalized safe fields, action create/update/skip, warnings/errors, candidate matches, and chosen resolution. Reject formulas in fields intended for later spreadsheet export or escape them on export; imported strings never become HTML.
- Commit requires admin confirmation of valid rows and explicit resolution/skip of invalid or ambiguous rows. Display exact creates, updates, skipped rows, and whether invitation sending is requested; default is no sends.
- Deterministic IDs/operation ledger keyed by org + kind + source externalId or job/row key prevent duplicate creation on retries. A source file uploaded under another job is not safe to deduplicate solely by name; compare external IDs and present ambiguity again.
- Execute bounded batches asynchronously with checkpoint and leases. Revalidate staff permission, target season status, current record revisions, and each relationship before each batch; stale preview returns needs-review rather than overwriting recent edits.
- Partial progress is visible and resumable; completed row IDs are recorded. Never pretend a multi-batch import is one atomic transaction. Produce downloadable outcome CSV with sanitized fields and row errors.
- Schedule commit creates reviewable drafts by default. Separate publish confirmation transitions selected events to published and queues one essential update per recipient/event revision; preview and import retries send nothing.

## Calendars, email, accessibility, and privacy

### Household calendar

- Native top-level navigation offers Household and Teams. Household shows the caller's combined upcoming calendar; Teams retains focused coaching and legacy team workflows. Organization administration lives in the web workspace.
- Cards show authorized participant labels, team, date/time, event type, location, and archived-season context. Filter by participant, team, type, organization, and season; default current seasons, with explicit archived toggle.
- Multi-child same-event results show one event with both names, not duplicated cards. Filter state is a preference, not an access grant. Remove unavailable filters after grants change.
- Use server pagination and stable startsAt/eventId ordering; date boundaries follow the selected display timezone. Clear previous account data on sign-out, account switch, and permission changes. Empty/loading/error/permission-removed states are separate.
- Phase 1 does not claim durable offline authorization or guaranteed background sync. A stale cached label must not imply a confirmed update or grant; sensitive participant data is not persisted in generic AsyncStorage caches.

### Revocable calendar subscriptions

- Implement server-generated RFC 5545 ICS, not a writable device calendar. Expo Calendar is optional for explicitly initiated one-off exports; it is not proof of automatic subscribed-feed support.
- `createCalendarSubscription({participantRefs,teamIds,eventTypes})` validates a caller-selected subset, issues a random bearer URL once, and stores hash/owner/scope/version/createdAt/revokedAt in server-only `calendarSubscriptions/{hash}`.
- HTTPS `calendarFeed` validates token, account deletion state, active guardian/self/team grants and current event visibility on every fetch. Do not cache private ICS publicly; redact tokens from logs. Revoked/invalid URLs return no event data and a generic expired-feed response.
- Feed fields contain title, start/end, team, location, event UID and modification sequence; exclude birth dates, contact emails, roster lists, internal notes, and other guardians' names. Household child-name inclusion is opt-in with a privacy explanation, default off.
- Stable UID is eventId + configured app domain; preserve across time changes. Increment SEQUENCE from event revision, use valid escaping/folding and UTC instants. Define date bounds, initial previous 30/next 365 days, and visible feed size ceiling; communicate bounded coverage.
- “Remove subscription” revokes the URL immediately, offers rotation, and gives calendar-client removal instructions. Third-party refresh cadence and already downloaded entries cannot be controlled; demonstrate this in the UI rather than promising immediate remote deletion.
- Require explicit confirmation when broadening scope. Adding a child does not silently expose that child's events through an old feed URL.

### Essential email foundation

- Phase 1 sends invitations and essential published-event information through a backend outbox; Phase 2 adds reminders, closures, critical acknowledgment and push channels.
- Configure a transport adapter with a development sink and a production mail service. Provider procurement, sender domain, SPF/DKIM/DMARC, quotas, regional processing and secret provisioning are external gates; no email credential belongs in native/public env variables.
- Server-only outbox keys include purpose + event revision/invitation version + recipient identity. Store pending/sending/sent/failed state, attempt count, nextAttemptAt, transport message ID and redacted failure code. Worker retries with bounded exponential backoff and a terminal failure queue.
- Exactly-once external delivery is not guaranteed: a crash after transport accepts can duplicate mail unless the provider supports idempotency. Use provider keys where available and disclose residual semantics; never retry invitations by generating new access grants.
- Resolve verified notification contacts from current grants, recheck permission before send, suppress revoked/deleted recipients, and handle bounce/suppression state. Show staff actionable failure counts without exposing other organizations' addresses.
- App-free emails include safe time/place changes and HTTPS read-only event access through scoped revocable links, or secure browser sign-in when child information is involved. No app installation is required to understand the essential update.
- Separate transactional communication preferences from optional promotional consent; any legal notice/opt-out policy remains an external policy gate before live mail.

### Accessibility completion criteria

- Native controls have meaningful accessibility roles, labels, state, focus order, and error announcements; icon-only calendar/filter buttons identify their action. Dialog focus returns to its trigger.
- Support enlarged text without clipped names/actions, sufficient contrast, non-color-only statuses, keyboard-safe forms, and touch targets suitable for phones. Use scrollable layouts rather than disabling text scaling.
- Browser forms support semantic labels, keyboard operation, visible focus, table headers, error summaries, and announced import progress without per-row noise.
- Manually test VoiceOver and TalkBack on real running affected screens, plus browser keyboard and screen reader. Automated role assertions and browser scans supplement these checks; they cannot establish usability alone.
- Capture and inspect changed native states with iOS Simulator/Android emulator and browser states from this checkout. Upload screenshots under PR **UI evidence**; a local path alone is not evidence. Include error/empty/large-text states when changed.

## Numbered implementation steps

Each numbered item is one bounded PR-sized step and one `/implement-feature` invocation. Complete its tests, UI evidence where relevant, PR subscription and AI feedback loop, then stop and update Handoff. Do not silently continue to another item. Split only if the implementer documents an unexpectedly large step before coding.

### 1. Establish executable security and compatibility fixtures

- Add Firestore/Auth/Functions emulator configuration, rules testing, representative fixtures and CI backend-test commands. Use isolated development project IDs and explicit emulator opt-in.
- Reproduce existing team-get and coach self-promotion issues in tests; record baseline behavior for team creation/join, event reads, rotation, super-admin tools and deletion.
- Add pure v2 schema fixtures and serializers without changing live storage behavior. Validate parent IDs, roles, timestamps, and legacy decode failures; malformed dates must not become `new Date()` silently.
- Acceptance: CI can execute rules/backend contract tests without live credentials; negative cross-org fixtures fail safely. Security defects are closed in the next atomic cutover, not merely documented.

### 2. Introduce server team/event commands and close legacy escalation

- Add createTeam/joinTeamWithInvite/regenerateInvite plus createEvent/updateEvent/softDeleteEvent commands with authenticated actor lookup, atomic ownership/member creation, invite rotation, event revision checks and request deduplication. Derive actor and immutable team/org references server-side; initially authorize legacy events by canonical coach membership, then add organization hierarchy validation in Step 3.
- Switch native team and event mutation adapters to callables while preserving current screens and return shapes. Deny direct client event writes, client-created coach membership, unscoped team gets and invite enumeration; expose safe server invitation lookup only. Old-client writes receive actionable update-required errors instead of retaining an unsafe compatibility path.
- Restrict self-editable user fields and team/membership/event reference updates. Validate event title/type/date/time/location inputs, reject reassignment to another team, preserve legitimate legacy player join and platform admin support tests. Legacy timestamps remain readable until the reviewed Step 4 conversion.
- Acceptance: unauthorized users cannot promote themselves, read unrelated teams, or submit forged createdBy; legacy authorized workflows still work. Capture native join/error/rotation states.

### 3. Add organization hierarchy and scoped staff backend

- Implement organization/program/season/division/team schema, revisioned server commands, permission helpers and filtered hierarchy reads. Extend Step 2 event commands to verify org/program/season/division/team consistency, immutable orgId, canonical teamIds, lifecycle/publication invariants and scoped actor permissions before any organization-v2 writes are enabled.
- Bootstrap first organization admin through a server-authorized owner action; do not let an arbitrary account assign itself to an existing organization. Archive is reversible and preserves history.
- Add audit records and expectedRevision conflicts; test immutable org references and program staff boundary.
- Acceptance: two-organization fixtures show isolation for every read/write; archived seasons remain read-accessible to legitimate actors and stop normal active-season edits.

### 4. Build reviewed legacy migration tooling

- Add dry-run manifest validation, deterministic participant/roster mapping, event-time conversion, legacy invite mapping and resumable checkpoints.
- Include count reconciliation, orphan report, invalid timezone/DST report, no-email mode and rollback/read-compatibility instructions.
- Acceptance: run twice against seeded emulator fixtures with identical IDs/counts; mapped records survive unchanged, unmapped records remain isolated and usable, and malformed rows require review.

### 5. Add participant, roster and guardian command boundaries

- Implement independent participants, private profile, roster enrollment, self-link approval, guardian approval/revocation and private discovery projections.
- All grant mutations transactionally update canonical records and access revision metadata; projections are never authoritative. Cross-org roster/guardian attempts fail.
- Acceptance: two guardians can independently read one child's authorized data; unrelated adult cannot link themselves; revocation blocks canonical reads immediately; same-name children remain distinct.

### 6. Expand account deletion before household exposure

- Implement deny-first resumable deletion, feed/token/grant cleanup hooks, participant unlinking and durable job audit; preserve legacy callable response compatibility.
- Cover last administrator, only guardian, multiple guardians, partial Auth deletion, retries and paging beyond one batch.
- Acceptance: deleted identity has no server access while worker is incomplete; organization history and other guardians survive; worker can resume without caller authentication.

### 7. Establish browser admin shell and hierarchy management

- Create isolated React/Vite admin app, shared pure contracts, browser Firebase initializer, email/password auth, authorized routes and staging Hosting config.
- Implement org/program/season/division/team CRUD and scoped staff assignment forms using established commands. Include archived views, conflict errors and cross-account cache clearing.
- Acceptance: production-mode browser build succeeds, direct URLs reauthorize, unauthorized scope is denied by server, and native build has no browser package coupling. Capture browser success/empty/error states.

### 8. Deliver roster and household profile UI

- Add web participant/roster management and native household participant selection/profile screens with guardian display, explicit acting-for labels and permission-removed handling.
- Native users keep existing Teams flow; account with coach + parent roles can switch context without changing login or child identity.
- Acceptance: required two-child/multi-role scenario works using seeded data; private fields are absent from coach roster responses and screenshots. Capture native/browser affected states.

### 9. Add scoped invitation lifecycle and browser fallback

- Implement hashed invitation tokens, expiry/revoke/resend/accept transaction and pending deep-link navigation after authentication.
- Add web invite list/status and acceptance pages, native recovery UX, verified-email mismatch handling and transport-independent queued outbox creation.
- Acceptance: replay, revoked, expired, wrong-email, concurrent accept and account-switch cases pass; legacy uppercase code parser does not corrupt opaque tokens.

### 10. Deliver server household agenda and native filters

- Add canonical event-time v2 adapters and index definitions, authorized agenda pagination, team/event deduplication, participant/team/type/season filters and clear timezone display.
- Preserve single-team screen behavior; only migrated published events enter household results, with an explicit setup-required explanation for unresolved legacy times.
- Acceptance: sibling same-event appears once with both labels; program staff sees no unrelated program; two-org parent sees both through personal access only; page boundaries and DST tests pass.

### 11. Implement private ICS subscriptions

- Add server feed encoder, create/list/revoke/rotate subscription commands and native/browser management screen with minimal scope and removal instructions.
- Test escaping, stable UIDs, changes, permission loss, account deletion, filtered bounds, non-public cache headers and redacted logging.
- Acceptance: subscribe on at least one iOS calendar and one other supported calendar client; document actual refresh behavior. Inspect feed response after revoke for absence of private data; do not confuse cached entries with server authorization.

### 12. Deliver roster CSV preview and resumable commit

- Add private import objects/jobs, server parser, versioned template, row resolution UI, duplicate handling, deterministic ledger and permissions-rechecked worker.
- Import participant/roster rows without activating guardians; optional send step creates invitation outbox entries only after explicit confirmation.
- Acceptance: quoted multiline/BOM/invalid UTF-8, duplicate external IDs, ambiguous names, stale preview, mid-import revoke, retry and partial failures yield visible deterministic results.

### 13. Deliver schedule CSV preview and explicit publication

- Extend existing import machinery with schedule template, local-time validation and event external-ID mapping; preview overlaps as warnings, not a claim of automatic scheduling.
- Commit drafts, then separately confirm publication and queue essential email using event revisions. Do not build the Phase 2 scheduler here.
- Acceptance: DST ambiguity blocks commit, double-click/retry never duplicates events or sends, existing event ID stays stable on update, and unpublished imports stay out of household feeds.

### 14. Connect essential email and app-free information

- Implement transport adapter, development mailbox, leased outbox worker, retry/failure states, contact suppression, private browser access and approved production sender configuration.
- Invitations and published-event mail include clear team/time/place and useful fallback/help links; do not implement marketing or paid entitlements.
- Acceptance: test mailbox proves content and recipient scoping; fault injection covers pre-send failure, post-send ambiguity and stale/revoked grants. Live delivery remains gated on actual sender setup and privacy policy.

### 15. Complete accessibility, migration rehearsal and pilot readiness

- Audit all introduced screens with enlarged text, VoiceOver/TalkBack and browser keyboard/screen reader; correct discovered issues rather than merely produce an audit list.
- Rehearse reviewed migration, email/feed revoke and deletion in staging with representative synthetic data, production indexes, realistic multi-team household and 5,000-row imports.
- Measure API latency/read counts and job throughput; proposed staging targets are agenda first page p95 under 2 seconds for 20 teams over 93 days, and 5,000-row preview/commit completion under 10 minutes. Record hardware/region/sample and adjust implementation before promising pilot capacity.
- Acceptance: all phase scenarios below pass with evidence attached; owner accepts external gates and operational runbook; later phase implementation is a separate user instruction.

## Proof and feasibility matrix

Labels map to the [shared evidence vocabulary](../plans/phase-plans.md): **code-confirmed** = source-confirmed; **doc-supported** = documentation-supported; **prototype-needed** = spike required; **external gate** = external decision or enablement. Source confirms the baseline only; documentation supports a mechanism; every new integration remains unrun until its named gate succeeds. No label means already shipped.

| Capability | Baseline source | Official technical support | Required proof before acceptance |
| --- | --- | --- | --- |
| Native version compatibility | [Package](../../package.json), Expo 54 / RN 0.81 / React 19.1 | [SDK 54 version matrix](https://docs.expo.dev/versions/v54.0.0/) | Code-confirmed + doc-supported; install/build development client and run affected native screens. |
| Tenant rules and safe queries | [Rules](../../firestore.rules), lines 60–121 | [Rules and queries](https://firebase.google.com/docs/firestore/security/rules-query) | Prototype-needed: emulator actor matrix plus staging indexes; no reliance on post-query filtering. |
| Server-owned commands | [Deletion callable](../../functions/src/index.ts), lines 34–87 | [Callable functions](https://firebase.google.com/docs/functions/callable) | Code-confirmed pattern; new auth/validation tests and native-to-emulator call prove integration. |
| Concurrent grants/import ledger | [Team batch](../../src/firebase/teams.ts), lines 160–186 | [Transactions and batches](https://firebase.google.com/docs/firestore/manage-data/transactions) | Doc-supported; concurrent acceptance/retry tests, bounded transaction size and no sends inside retried transaction. |
| Household identity isolation | [Current identity model](../../src/types/models.ts), lines 30–37 | [Secure queries](https://firebase.google.com/docs/firestore/security/rules-query) | Prototype-needed: guardian/revoke/cross-org fixtures and endpoint response inspection; framework support alone does not prove policy. |
| Browser admin stack | [Native bootstrap](../../src/firebase/config.ts), lines 18–49 | [Vite guide](https://vite.dev/guide/), [Hosting quickstart](https://firebase.google.com/docs/hosting/quickstart) | Doc-supported; standalone browser production build/auth/route test required; hosting domain is external gate. |
| Calendar instants and subscription encoding | [Legacy event model](../../src/types/models.ts), lines 51–64 | [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545), [SDK 54 Calendar](https://docs.expo.dev/versions/v54.0.0/sdk/calendar/) | Prototype-needed: DST round trips, feed parser, actual subscribed clients and revocation inspection. No promise of client refresh timing. |
| Invitation HTTPS fallback | [Legacy parser](../../src/lib/deepLink.ts), lines 1–28 | [SDK 54 Linking](https://docs.expo.dev/versions/v54.0.0/sdk/linking/) | Doc-supported; cold/warm app and browser acceptance tests, domain association configuration external gate. |
| Reviewed CSV imports | No current import module; [backend package](../../functions/package.json) | [Transactions](https://firebase.google.com/docs/firestore/manage-data/transactions), [Storage rules](https://firebase.google.com/docs/storage/security) | Prototype-needed: canonical parser fixtures, private upload authorization, replay/partial-progress tests and 5,000-row staging measurement. |
| Essential email | No current transport/outbox | [Document-triggered email pattern](https://firebase.google.com/docs/extensions/official/firestore-send-email), [Retry behavior](https://firebase.google.com/docs/functions/retries) | Doc-supported pattern, not selected extension mandate; transport adapter prototype and production sender external gate. |
| Accessibility | [Shared UI](../../src/components/ui.tsx), lines 57–85 | [RN 0.81 accessibility](https://reactnative.dev/docs/0.81/accessibility) | Prototype-needed: actual screen-reader/large-text sessions; platform props are insufficient proof. |
| Migration and deletion | [Current cleanup](../../functions/src/index.ts), lines 27–86 | [Emulator connection](https://firebase.google.com/docs/emulator-suite/connect_firestore), [Transactions](https://firebase.google.com/docs/firestore/manage-data/transactions) | Code-confirmed old cleanup; dry-run/replay/revoke-first deletion rehearsal and reviewed retention policy required. |

These rows provide a viable implementation path, known constraints and falsifiable proof requirements. They do not certify performance, privacy compliance, browser deployment, deliverability or migration success before execution.

## Tests, rollout, and operational acceptance

- [ ] Security: unrelated user; forged coach; program staff out of scope; cross-org team/participant/event IDs; role changes; archived records; private fields; revocation during in-flight agenda/feed/mail/import.
- [ ] Identity: coach + parent + player account; two guardians; two children sharing name; same child represented separately in two organizations; account deletion leaves other guardian intact.
- [ ] Compatibility: legacy join/rotation/create/edit; synthetic old user with missing optional fields; explicit organization mapping; orphan references; existing IDs and soft deletion; unmapped teams; old binary update messaging.
- [ ] Calendars: same event for siblings; overlapping events; filters across organizations; zero events; pagination ties; timezone/DST; subscription rotation; access removed; cached remote entries clearly explained.
- [ ] Imports: preview produces zero writes/invites; malformed/missing headers; quoted multiline data; repeated external ID; no-ID ambiguous duplicate; formula-like values; changed preview; concurrent edit; interrupted batch; rerun; authorization removed mid-job.
- [ ] Email: separate authenticated guardians receive appropriate messages; no unrelated recipients; accepted-vs-read distinction; bounce/failure visible; app-free fallback; suppression; no token in logs.
- [ ] Accessibility: native VoiceOver/TalkBack, large text, browser keyboard/screen reader, errors and progress announcements. Screenshots supplement interaction evidence.
- [ ] Operations: alerts for failed jobs, growing outbox age and abnormal permission failures; structured correlation IDs without participant names/token values; documented recovery and support ownership.
- [ ] Release: isolated emulator fixtures, staging deployment/index readiness, reviewed migration manifest, gradual organization feature flags, owner-approved pilot enrollment; no paid entitlement gate while commercial selection is pending.

Proposed feature flags are server-owned per organization: `organizationV2`, `households`, `adminWorkspace`, `imports`, `calendarSubscriptions`, `essentialEmail`. A flag controls rollout only and never grants access. Rollback hides new entry points and stops new jobs; already-issued grants must still be revoked and already-completed data retained safely.

External gates: organization/timezone mapping approval; production Firebase project/billing/deployment access; email sender/provider/domain; HTTPS app-link domain; privacy/minor contact/retention policy; support owner; pilot partners and agreed measures. Implement local/staging portions before asking the owner to resolve these; do not silently choose legal or commercial policy.

## Files to touch

Existing integration anchors: [models](../../src/types/models.ts), [rules](../../firestore.rules), [indexes](../../firestore.indexes.json), [Functions entry](../../functions/src/index.ts), [native root](../../App.tsx), [team adapter](../../src/firebase/teams.ts), [event adapter](../../src/firebase/events.ts), [account adapter](../../src/api/account.ts), [shared UI](../../src/components/ui.tsx), [deployment config](../../firebase.json).

Proposed, uncreated locations: `shared/` contracts, `admin/` browser application, `functions/src/{organizations,participants,invitations,imports,calendar,email,migrations}/`, `scripts/migrations/`, `src/screens/HouseholdScreen.tsx`, `src/screens/ParticipantProfileScreen.tsx`, `src/screens/CalendarSubscriptionsScreen.tsx`, backend/emulator test fixtures. Do not create empty scaffolding for future phases merely to match this inventory.

## Handoff

### Done so far

- Inspected current models, rules, adapters, UI anchors, deployment configuration and account deletion.
- Read exact SDK 54 references and official backend/browser/calendar/accessibility documentation.
- Defined PR-sized work, migration contracts, security boundaries and required proof.
- Step 1 implemented: `firebase.emulators.json`, `scripts/test-backend.mjs`, `tests/backend/`, `shared/contracts.ts`, and the backend CI job. At Step 1, live rules/adapters/Functions behavior was unchanged.
- Step 1 validation: `yarn typecheck`, 13 existing suites/93 tests with coverage, and 14 backend tests (5 pure contracts, 7 rules, 2 callable integration) passed locally. The direct rules-test invocation without emulator opt-in was rejected before database access. Local runtime: Node 24.19.0 and Java 26; CI uses Node 22 and Java 21. No production credentials or data used.
- Step 1 UI evidence: not applicable; no user-visible behavior changed. Both known rule vulnerabilities are reproduced intentionally, with cutover instructions in `docs/backend-testing.md`.

- Step 1 PR #5 merged on 2026-10-11; the earlier unmerged status is superseded.
- Step 2 implements server actor lookup, atomic team/player/invite commands, event validation/revisions, request receipts and the restrictive rules cutover. Native mutations use callables and loaded event revisions; legacy timestamp reads remain unchanged. Organization-v2 commands remain refused until Step 3.
- Step 2 validation: typecheck, 91 native tests with coverage and 23 emulator tests pass under Node 24.19.0 / Java 26; CI uses Node 22 / Java 21. No production data or deployment. Native iPhone 17 Pro / iOS 26.5 used this checkout’s Metro 8081 bundle with demo-only loopback emulators. Nine inspected screenshots are attached under PR #6 **UI evidence**, covering create/rotation, inactive-code error, player join, stale edit, successful reload/save deletion conflict, profile save after removal and final invite rotation on `6b00e32`. Existing native development client reused because native dependencies did not change.
- Greptile’s three findings (profile preference, denial-test isolation and retry action identity) were fixed with regression tests in two fix rounds. Re-review on `6b00e32` completed with zero new comments and all bot threads resolved. Macroscope provided a summary but no correctness check on this draft. PR subscription is verified through the REST notification-thread API. The GraphQL subscription endpoint requires a scope unavailable to this token. Local evidence is retained under `/Users/orkunozekin/.codex/visualizations/2026/10/11/01a12b56-57cd-7e73-9953-7f86c4e281ef/step-2-evidence/`.

- Step 2 PR #6 merged on 2026-10-11. The earlier unmerged/draft status above is superseded.
- Step 3 adds `functions/src/organizations/{commands,policy,events}.ts` and reusable command support: owner-gated atomic organization bootstrap, canonical staff scope, revisioned hierarchy/team/staff mutations, private audit records, filtered/paginated hierarchy and organization discovery reads, reversible season archive, and v2 event parent/team/lifecycle/publication checks. Tenant references are immutable. Legacy invitation/mutation behavior stays separate.
- V2 hierarchy/team/events remain client-denied and use scoped callables. The existing native support directory now uses a paginated legacy-only callable and updated scope copy to prevent a broad query leaking v2 teams. Legacy support entry still works; production callable deployment must precede adapter/rules cutover.
- Step 3 local validation: Functions build, client typecheck, 14 native suites/91 tests with coverage, and 37 emulator/contract/callable tests passed using Node 26.3.0 and Java 26. CI remains Node 22/Java 21. Fixtures prove two-organization and same-org program isolation, stale revisions/concurrency, replay/revocation, archive preservation/restoration, canonical multi-team events, direct-read denial and legacy support filtering. No production data, owner grants or deployments were used.
- UI evidence inspected on iPhone 17 Pro / iOS 26.5 with this checkout's Metro 8081 and explicit `demo-team-hangout` loopback emulators. Verified legacy team entry and retained success/empty/denied screenshots under `/Users/orkunozekin/.codex/visualizations/2026/10/11/01a12c09-2381-7091-9a64-99b3c9c832d9/step-3-evidence/`. All three captures are attached under PR #7 **UI evidence**. Greptile reviewed the draft after an explicit mention and found a valid event-time replay bug. The fix returns the saved receipt after current authorization/scope checks and before merging the old patch into later state. A regression proves later edits remain intact, no audit is duplicated and revoked coaches cannot replay. All 36 backend tests and both CI jobs passed before the archive-replay fix. Greptile re-review on `7c9dd17` completed with no new findings and 5/5 confidence; the bot thread is resolved. Macroscope then identified archive restrictions incorrectly blocking completed-command replay. The fix skips only write-specific archive checks for receipts while retaining current authority and parent integrity, with a regression covering hierarchy, team, staff and event commands. All 37 backend tests pass; re-review is pending.

- Step 3 PR #7 merged on 2026-10-11. Earlier open/re-review-pending status above is superseded.
- Step 4 adds offline `functions/src/migrations/legacy.ts`, an emulator-only review/apply CLI and example manifest under `scripts/migrations/`, and `docs/legacy-migration.md`. Dry runs report counts, orphans, invalid parents/times and unmapped teams. Reviewed checksums, deterministic organization-local player IDs, lossless timestamp review files and atomic per-target checkpoints support interruption and safe replay. Legacy IDs/fields, coach assignments, code strings and soft deletion remain intact; converted events stay staged and no email/grants are generated.
- Step 4 local validation: Functions build, client typecheck, 14 native suites/91 tests and 42 backend tests pass on Node 26.3.0 / Java 26 (CI uses Node 22 / Java 21). No production reads, credentials, deployment or live migration.
- Step 4 adds synthetic tests in `tests/backend/migrations.test.mjs`, including DST gaps/folds and half-hour transitions, malformed rows, source/target drift, resume/replay/count reconciliation, distinct same-name identities and actual unmapped legacy access. Native UI, deployed callables and rules are unchanged; UI evidence is not applicable.

- Step 4 PR #8 merged on 2026-10-11. Earlier open status is superseded. Greptile and Macroscope were unavailable due to exhausted credits; missing AI review was not treated as approval.
- Step 5 adds `functions/src/participants/{commands,policy}.ts`, callable exports and scoped organization discovery. Independent participants, private admin profiles, explicit adult self-link/unlink, guardian approval/revocation, scoped roster writes/reads, sanitized household profiles, approved contact edits and private participant discovery recheck canonical authority. Every grant/enrollment/archive update transactionally advances access metadata and per-participant discovery sources; stale links never grant access and sibling access survives individual revocation. All new direct Firestore paths remain denied.
- Step 5 API/revision/index/operational contracts are in `docs/participant-boundaries.md`. Org-wide identity/grants/private profiles are admin-only; program staff manage assigned-program rosters. Atomic fanout supports 10 active guardians and 20 enrolled teams per participant; oversized migrated identities need a separately reviewed bulk path before exposure. Household reads remain gated by the server-owned `features.households`, which this step does not enable. Expanded deletion is Step 6; UI is Step 8.
- Step 5 local validation: Functions build, client typecheck, 14 native suites/91 tests with coverage and 54 backend/contract/rules/callable tests pass on Node 26.3.0 / Java 26. Locked dependency installation needed `--ignore-engines` for this local runtime; CI uses supported Node 22 / Java 21. Fixtures cover two guardians, distinct same-name children, org/program isolation, canonical revocation, replay/concurrency, private response allowlists, sibling projections, archived unlink/removal, account/rollout gates, pagination and atomic limit failures.
- Final Step 5 rollback-safety review preserves admin guardian revocation and self-unlink even when organization rollout is disabled; the archived/disabled guardian regression passes with all 54 backend tests. No fresh approvals bypass rollout gates.
- Step 5 UI evidence: not applicable; no screens, components, native adapters or user-visible UI interactions changed. No production data, deployment or feature-flag changes.

- Step 5 Greptile feedback: preserve omitted contact fields in `editParticipantProfile`; explicit null clears only the supplied field. The regression covers phone-only/email-only updates, null clears, birth date/private-note/creation-metadata preservation, replay after later edits and omitted-versus-null request identity. A durable lesson is recorded in `docs/AGENT_LESSONS.md`. Local validation: 55 backend tests, client typecheck and 91 native tests with coverage pass. No UI change.

- Step 5 PR #9 merged on 2026-10-11; earlier unmerged statuses are superseded.
- Step 6 adds `functions/src/accounts/deletion.ts`, durable account tombstones, shared callable/assignment gates and rules denial. Bounded atomic cleanup pages remove grants and hooks, unlink self participants and preserve organization/child history and other guardians. Auth failure remains denied and resumes under the scheduled service worker without a caller token. Last-admin and only-guardian recovery flags do not block deletion or confer replacement authority. Initial deletion requires recent sign-in; legacy response fields remain compatible.
- Step 6 validation: Functions build, client typecheck, 14 native suites/91 tests and 60 backend tests pass on Node 26.3.0 / Java 26. New tests cover 520 memberships, the backward-compatible pending callable response with service-driven completion, interrupted/concurrent workers, cached tokens, recreation denial, hook cleanup, preserved guardian reads, recent auth, and Auth failure/provider-success recovery. No production data or deployment used. Both CI jobs pass using Node 22 / Java 21. Native iPhone 17 Pro / iOS 26.5 ran this checkout’s Metro 8086 with explicit demo-only loopback emulators. Inspected warning and signed-out result screenshots are attached in PR #10 **UI evidence**; the native call completed deletion, preserved the legacy team and flagged last-admin recovery. Local captures are retained under `/Users/orkunozekin/.codex/visualizations/2026/10/11/01a12d06-e770-7450-8e00-d4ee23ced16f/step-6-evidence/`.
- Step 6 operational and future collection ownership contracts: `docs/account-deletion.md`. Retention/pseudonymization policy remains a live rollout gate; unstructured organization-owned notes cannot be safely attributed to one account.

- Step 6 PR #10 merged on 2026-10-11; earlier unmerged statuses are superseded. The user-supplied plan in worktree `60b9` was an older planned copy; Step 7 continues this repository's existing plan after verifying all prerequisite PRs merged.
- Step 7 adds the isolated `admin/` React/Vite browser package and pure `shared/admin.ts` callable contracts. Email/password auth, existing-account reset, authorized direct routes, organization picker, hierarchy creation/edit/archive/restore, scoped staff assignments, loaded-revision conflicts and action-specific retry IDs use canonical server commands. Auth changes discard tenant state and in-flight responses; no hierarchy storage cache is introduced.
- New `getAdminWorkspace` requires live staff and the server-owned `features.adminWorkspace` flag. `listOrganizationStaff` is admin-only, paginated and allowlisted. Native TypeScript and Jest exclude browser files. CI adds a separate production-build/browser/emulator job. `firebase.admin-staging.json` defines an unbound Hosting target without selecting a project or deploying. Operational contracts are in `docs/browser-admin.md`.
- Step 7 local validation: normal production-mode browser build, Functions build, client typecheck, 14 native suites/91 tests with coverage, iOS Hermes bundle export and 61 backend tests pass on Node 26.3.0 / Java 26. CI uses Node 22 / Java 21. Two real Chrome browser flows against isolated demo Auth/Firestore/Functions emulators pass, including loading and no horizontal overflow at 390px. Twelve inspected captures are retained under `/Users/orkunozekin/.codex/visualizations/2026/10/12/01a1306a-be4f-7911-885a-5d1e4b8017e6/step-7-evidence/` with SHA-256 manifest; All 12 captures are attached under PR #12 **UI evidence**, including the retained-retry state. Greptile identified focus-driven edit/retry loss and unnecessary history reads. Both are fixed in `b8a54f2`; real browser regressions retain unsaved edits and the exact uncertain-save action across focus, verify one committed program after replay, clear revoked access, and assert section-specific reads. Both bot threads are replied to/resolved; the required new top-level `@greptileai` comment requested re-review. Greptile reviewed 32 files with zero new comments and 5/5 confidence. Macroscope remains unavailable due to exhausted credits. No production data, deployment, live flags or owner grants changed.

- Step 7 CI on `b8a54f2`: native and backend jobs pass; browser entry reached the expected empty state just after the default five-second assertion deadline on cold Linux emulators. The failure artifact confirms successful rendering. Browser tests now allow a bounded 15-second assertion wait and 120-second scenario limit; both local flows pass again. This changes test timing only. The inspected retry screenshot is retained locally as `11-retained-retry.png` and attached in the PR description. The final evidence update preserved Greptile’s generated section verbatim. All three CI jobs pass on `9d9809c`; no UI changes followed the final captures.

- Step 7 mobile refinement in `7a376cc`: organization navigation collapses behind an accessible Menu button at mobile/tablet widths and closes after selecting a section. Mobile buttons and table cells use compact padding; season dates remain intact on two lines. Both real Chrome/emulator flows and the production build pass, with menu interaction coverage and no document overflow at 390px. Collapsed/expanded captures were inspected and uploaded to PR #12, replacing the old mobile image while preserving Greptile’s generated section. Local mobile evidence provenance is in `mobile-manifest.json`. Fresh CI and Greptile re-review were requested; verify final remote results before merging.

- Step 7 hamburger refinement: matched the newer StoryTurn worktree’s three rounded bars, 300ms outer-bar rotation into an X and 200ms middle-bar fade/scale. The icon-only toggle keeps accessible open/close labels, expanded state, a 44px target and reduced-motion support. Browser coverage checks open/close, keyboard closure, final icon states and reduced motion. Updated mobile captures replace the earlier menu-button evidence in PR #12; fresh CI and AI re-review must be verified before merging.

- Step 7 PR #12 merged in `5ef8506`, confirmed against remote main on 2026-10-12. The earlier open/re-review-pending handoff is superseded.
- Step 8 adds native `HouseholdScreen` with participant selection, approved guardian display, explicit acting account/participant labels, permission-gated contact editing and revoked-access cleanup. Signed-in accounts without a legacy team can enter Household; the existing team flow remains available. Browser `Participants.tsx` adds admin identity/private-profile/guardian management and scoped staff roster enrollment, jersey edits, removal/restoration.
- Step 8 supporting reads: admin-only paginated `listOrganizationParticipants`; canonical profile relationship/edit rights and sanitized guardian summaries; staff-only optional removed-roster history with revisions. Coach roster allowlists remain unchanged. `shared/participants.ts` contains pure client contracts. `scripts/seed-household-demo.mjs` refuses live/non-loopback services and seeds two children, two guardians and a parent/coach account for native/browser verification.
- Step 8 validation so far: 62 backend tests, 15 native suites/94 tests with coverage, Functions build, client typecheck, normal production browser build and iOS Hermes bundle export pass on Node 26.3.0 / Java 26. New native tests required the existing testing library's missing compatible `test-renderer` peer; it is a dev dependency only. All five real browser/emulator scenarios pass, including temporary read failures preserving unsaved edits. Native screenshots verify two children, two guardians, editing versus view-only access, explicit save confirmation/result, retained coaching role, revocation preserving sibling access and the empty household. Browser captures cover admin profiles, rosters, empty/removed access and temporary failures. PR #13 is open at https://github.com/orkunozekin/team-hangout/pull/13 and subscription is verified. Greptile’s hidden-tab reload and temporary-error edit-loss findings are fixed with regressions; All three CI jobs pass on `0da944b`; the preceding `797223b` re-review completed with 21 files reviewed and zero new comments. The later commit only corrects the regression test’s AppState callback type. Both bot threads are replied to/resolved; Macroscope skipped because credits are exhausted. Fourteen actual browser/native captures were inspected and retained with captions/SHA-256 manifest under `/Users/orkunozekin/.codex/visualizations/2026/10/12/01a13106-23ef-73e3-86e1-cf97ff0f4f78/step-8-evidence/`. Screenshot upload is blocked: GitHub’s description attachment chooser keeps Open disabled after PNG selection, including All Files and direct full-path selection; coordinate fallback returns `Computer Use server error -10005: noWindowsAvailable`. No images were uploaded or posted in comments; PR description preserves Greptile’s section and records missing evidence. No production data, deployment or live flag changes.

- Step 9 adds scoped admin create/resend/revoke/list commands, hash-only token lookup, encrypted queued delivery payloads, verified-email recipient confirmation and atomic guardian/adult-self acceptance. Browser and native routes recover from wrong email, unverified email, expiry, revocation and stale authority without automatic acceptance. Account deletion cleans nested invitation records. See `docs/invitations.md` for lifecycle and deployment contracts; actual mail delivery remains Step 14.
- Step 9 validation: Functions build, client typecheck, browser build, 71 backend tests, 17 native suites/99 tests and nine real browser/emulator scenarios pass on Node 26.3.0 / Java 26. CI uses Node 22 / Java 21. Sixteen inspected browser/iPhone 17 Pro iOS 26.5 captures are retained outside source under the current chat's `step9/` evidence folder. Native Metro 8089 and browser 4177 ran this checkout with synthetic loopback data. A native race regression also proves a late acceptance cannot replace a newly opened invitation. All sixteen screenshots are attached under PR #14 **UI evidence**, and notification subscription is verified. Greptile initial confidence was 4/5. Its three findings are fixed with regressions: resend transfers approval while preserving creator history, inspection shares acceptance eligibility and returns reviewed-resend guidance, and denial invalidates delayed browser reads. Two browser recovery captures and one native recovery capture were inspected and attached. Fresh CI and Greptile re-review are pending; Macroscope is unavailable because credits are exhausted. The user authorized squash merge only after Greptile 5/5 and passing checks. No production data, deployment, live flags, email transport or associated-domain changes.

- Step 9 PR #14 squash-merged as `84ebee5` after Greptile 5/5 on `86bb731` and all three CI jobs passed. Three bot threads resolved; Macroscope skipped because credits were exhausted. Earlier open/re-review-pending notes are superseded. Requested UI refinements are a separate follow-up, with 101 native tests and nine browser scenarios passing and inspected browser/native evidence. Step 10 remains untouched.

- Step 9 refinement PR #15 merged as `0e589c8`, confirmed 2026-10-12. Earlier open/re-review-pending notes are superseded. The user-supplied worktree `60b9` plan is stale; this checkout's existing plan continues the merged implementation history.
- Step 10 adds `functions/src/calendar/agenda.ts`, `shared/agenda.ts`, the canonical native adapter and `HouseholdAgenda` integration. Live guardian/self/staff/coach authority, rollout/deletion and hierarchy checks govern bounded per-team queries, exact timestamp/event-ID pagination, event/participant deduplication, and private response allowlists. Canonical personal discovery supports migrated self identities without navigation projections. Filters narrow participant/team/type/organization/season scope; archival is explicit and date windows use display-timezone boundaries. Legacy single-team behavior remains intact; unresolved legacy times receive setup guidance.
- Step 10 validation: Functions build, client typecheck, 21 native suites/110 tests with coverage, and 79 backend tests pass on Node 26.3.0 / Java 26; CI uses Node 22 / Java 21. Backend fixtures cover siblings, multiple teams/organizations, program isolation, forged projections, lifecycle/publication/archive/rollout gates, canonical revocation, deletion, tied/sub-millisecond pagination and DST folds. Native tests cover filters, delayed reads, permission removal, empty/error/setup states, DST calendar boundaries and skipped dates. The final eight agenda regressions also pass after canonical discovery and malformed-time defenses, including a missing-timezone record.
- Step 10 native evidence: iPhone 17 Pro / iOS 26.5 using this checkout's Metro 8088 and explicit `demo-team-hangout` loopback emulators. Seven real inspected captures cover sibling deduplication, Jamie-only results, filter controls, empty results, second-organization personal access, permission removal and retained legacy Schedule. Permission removal testing caught and fixed stale participant labels, including cancellation of delayed discovery. Captures and provenance are retained outside source in the chat's `step-10-evidence/` folder; All seven images are attached under PR #16 **UI evidence**; a SHA-256/caption/source manifest is retained beside them. PR subscription is verified as `SUBSCRIBED`. All three CI jobs pass on `1e2dce1`; Greptile base review is running. Macroscope checks skip because credits are exhausted. AI review and the user-authorized conditional squash merge remain pending. No production data, deployment, live flag changes, ICS or later-step implementation.

- Step 10 Greptile initial review gave 4/5 and found stale participant discovery after successful calendar-only reloads with reduced grants. The fix reauthorizes surrounding discovery after successful first-page reads through a separate generation, cancels older discovery responses, and preserves calendar filter/pagination state without a refresh loop. Two new regressions and an explicit loading assertion pass with 112 native tests and typecheck. A new inspected native capture verifies that revoking Jamie removes Jamie from events and profile buttons while Casey/Riley remain. It is attached under PR #16 **UI evidence**; fresh CI and Greptile re-review are pending. The durable lesson is in `docs/AGENT_LESSONS.md`.

### Remaining work

1. Finish Step 10 PR #16 AI review and verify final-head CI; the user authorizes squash merge only after Greptile 5/5 and all checks pass.
2. Next implementation invocation is Step 11 only: private ICS subscriptions. Steps 11–15 remain incomplete; no live rollout, mail delivery or migration has run.

### Blockers / risks

Steps 1–9 are merged; Step 10 is in review. Keep household rollout disabled until later exposure prerequisites are met. Step 7 staging Hosting site, Auth domain, project configuration and live rollout remain owner-controlled external gates. Step 2 closes direct coach creation, broad team gets, client event writes, invite reads and reference reassignment. Already-shipped binaries receive Firestore permission-denied errors; custom update-required text cannot be injected into shipped code by rules. Deployment ordering and historical coach-assignment review remain rollout requirements. Legacy native UTC-date/local-label display remains unchanged. Step 4 converts only reviewed date labels in synthetic migration runs; live timezone ownership still needs owner approval. The tool deliberately refuses staging/production, and mapped v2 teams remain denied to legacy clients until scoped readers/UI and participant/invite command boundaries land. Live cutover requires those prerequisites, quiesced writers, expanded readers, rollout gates and separately reviewed execution/retention/rollback policy. Email, domain, retention and production migration approvals remain external gates. Browser/ICS/import scale are doc-supported approaches awaiting executable proof.

### Pointers for the next agent

For Step 11 start at `docs/household-agenda.md`, `functions/src/calendar/agenda.ts`, `shared/agenda.ts` and the subscription design above. Existing browser foundations: `docs/browser-admin.md`, `admin/src/`, `shared/admin.ts`, `functions/src/organizations/commands.ts` and `admin/tests/workspace.spec.ts`; Step 8 identity contracts are in `docs/participant-boundaries.md`; migration guidance remains in `docs/legacy-migration.md`; backend setup is in `docs/backend-testing.md`. Reuse the saved review plan/checksum after partial migration, never regenerate it from converted data. Run `yarn test:backend` with Node 22 and Java 21+. Pure contracts are not live authorization or migration code. Preserve the canonical organization-local participant identity and existing team/event IDs. Do not infer guardian rights or organization ownership. Do not claim a test was run without its output. Every UI PR requires current-checkout inspected captures; every implementation PR targets main on a codex branch, subscribes to review, uses address-pr-feedback, requests fresh bot re-review after fixes, and leaves merging to the owner.
