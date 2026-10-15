# Backend security and compatibility tests

Run with Node 22, Java 21 or later, and dependencies installed:

```sh
yarn install --frozen-lockfile
yarn --cwd functions install --frozen-lockfile
yarn test:backend
```

The runner builds Functions and starts Auth (9099), Firestore (8080) and Functions (5001) on loopback under `demo-team-hangout`, using the separate `firebase.emulators.json`. No Firebase login, production credentials, `.env.local`, or native Firebase initialization is needed. The Firebase CLI may download emulator binaries on first use. Stop any services using these ports first. Emulator state is disposable synthetic data. The test files require an explicit runner opt-in, demo project and exact loopback emulator hosts before initializing database clients. Files run serially because rules fixtures clear Firestore between tests.

`yarn test:contracts` runs pure boundary fixtures without emulators. `shared/contracts.ts` has no Firebase or native imports and is not used by live storage adapters yet. Timestamp JSON uses canonical UTC ISO strings with millisecond precision; sub-millisecond storage precision is intentionally truncated. The legacy date review decoder fails on missing or malformed input; live legacy mappers retain their current behavior until the later cutover/migration.

## Step 2 cutover expectations

The emulator suite tests deployed rule source and the real `deleteAccount` callable, rather than mocks:

| Surface | Step 2 expectation |
| --- | --- |
| Team creation | Authenticated callable atomically creates team, coach membership and invite lookup. Direct writes fail. |
| Player join | Server-only active-code resolution creates canonical player membership; missing/rotated codes deny join. |
| Event reads | Team members see non-deleted team events; unrelated team reads, broad queries and deleted events fail. Players cannot write events. |
| Invitation rotation | Coach callable replaces lookup and team code atomically; retries return the original result and players cannot rotate. |
| Platform support | Super admin can list teams and manage legacy teams/events through commands; self-promotion and direct authority writes fail. |
| Account deletion | Unauthenticated call fails; authenticated call removes own Auth/profile/memberships, preserves other identities and team/event history, and tolerates missing Auth user on retry. |
| Future tenant data | Organization/private-profile/navigation paths remain default-denied, including cross-org payloads and platform admins. |

The two Step 1 vulnerability reproductions now assert denials. All client event/team/invite writes and membership creation/updates fail, including coach and platform-admin direct writes. Users may update only display name, authorized active-team preference and server update time; platform role updates remain a narrow support operation. Existing legacy event timestamps remain readable. Commands refuse organization-v2 records until Step 3 adds hierarchy policy.

`tests/backend/commands.test.mjs` exercises real callable authentication, actor derivation, input validation, concurrent create/join retries, invite rotation, stale revisions, immutable references, revocation and platform support. Successful command receipts are server-only in `commandRequests`; the same caller/operation/request ID with a different normalized payload fails with `REQUEST_ID_REUSED`. Event documents without a revision start at zero and acquire revision one on their first command edit. Native forms submit the revision they loaded; conflicts instruct users to reload rather than overwrite.

## Deployment and old-client compatibility

Deploy and verify the new Functions first, release the callable-based native client, then deploy the restrictive rules as one reviewed cutover. Never reopen direct writes as a rollback. These tests use emulators only; no deployment was performed. Review historical coach assignments before any tenant rollout because existing forged memberships cannot be distinguished from legitimate ones by their stored role alone.

Already-shipped binaries perform direct Firestore writes. Rules deny those writes with the SDK's `permission-denied` error; Firestore rules cannot supply custom update-required text to existing binaries. This is a remaining rollout messaging limitation, not an insecure compatibility exemption. The new command adapter provides actionable update/support guidance when a backend command is unavailable, and event conflicts provide reload guidance. A forced-update mechanism for already-shipped binaries would need a separately supported distribution/version gate.

## Native emulator validation

Use the existing development client with a Metro server from this checkout, and explicitly set `EXPO_PUBLIC_USE_EMULATORS=1`, `EXPO_PUBLIC_FIREBASE_PROJECT_ID=demo-team-hangout`, a synthetic API key, auth domain and app ID. Start the same loopback emulators with `firebase emulators:start --config firebase.emulators.json --project demo-team-hangout --only auth,firestore,functions`. Native simulator opt-in is development-only and rejects non-demo project IDs; demo projects refuse to run without opt-in. The loopback addresses target iOS Simulator; Android device routing is not configured by this step. Seed disposable users through the local Admin SDK. Never use production credentials or data for captures.

Canonical contract fixtures independently reject mismatched organization/program/season/division references, cross-org event team sets, malformed roles/revisions/timestamps and invalid event lifecycle/publication values. These pure validators do not grant authorization, implement hierarchy commands, prove future tenant access, or prove production indexes. Later steps must test those policies against their actual handlers and rules.

CI runs both the existing native unit/coverage job and a separate emulator job without live secrets. Native UI evidence for Step 2 is recorded in its PR and feature handoff.

## Step 3 organization commands

`organizations.test.mjs` exercises the actual callables with two isolated organizations and synthetic actors. Hierarchy and v2 event writes validate current canonical staff/coach grants, every parent reference, revision, account state and the server-owned `features.organizationV2` flag. Platform `superAdmin`, discovery links and legacy coach roles do not establish organization authority. Own team assignment metadata remains self-readable; v2 hierarchy, team/event content and audits are callable-only. All client hierarchy/authority writes stay denied.

Provision `organizationOwners/{uid}` with `{enabled: true}` only through an explicitly authorized trusted server owner action in the intended environment. No client can read or write these grants. The `createOrganization` callable creates a new opaque organization ID and its first administrator atomically; it cannot attach the caller to an existing organization. Do not infer owner grants from profile roles or email domains. No owner grant or production deployment is created by this change.

Hierarchy mutations use `requestId`, `expectedRevision` (zero for creation), and server-generated IDs. `saveHierarchyEntity` accepts `kind: organization|program|season|division` and full `fields`; organization updates require `entityId == orgId`. Parent references cannot be edited or used to adopt legacy entities. `saveTeam` creates v2 teams without legacy invitation codes or implicit coach grants. Staff assignment requires an org admin, validates all program IDs and writes a private discovery pointer atomically. Self-demotion is refused; another current administrator can perform handover. `archiveSeason` accepts archived/active/draft with a revision check. Archive changes only status, keeps descendants/history intact, permits authorized reads and blocks normal child/event edits until restored. Restoring a season also requires active parent organization/program.

`listMyOrganizations` rechecks live membership for each discovery pointer. `listOrganizationHierarchy` accepts `orgId`, `kind: program|season|division|team` (default program), optional `programId` and `seasonStatus` (seasons only). Program staff must select an assigned program except when listing their assigned programs. Both use document-ID cursors and page sizes 1–50. Revoked/deleting actors cannot replay receipts or use stale projections. Pagination is not a snapshot across requests; callers must accept changes between pages. Indexes cover team org/program and season program/status filters; other filters use single-field indexes plus document ID. Deploy and verify these indexes in staging before rollout; emulator success does not prove production index readiness.

V2 `createEvent` requires canonical `teamIds` (1–20, unique, first equals top-level teamId), explicit UTC `startsAt`/`endsAt`, valid IANA `timeZone`, scheduled lifecycle and staged/published state. The backend derives org/program/season and division (null for a mixed-division event), checks every team and requires either scoped staff or active v2 coach grants for every team. Update cannot change tenant/team references or forge publication operations; Phase 2 lifecycle controls remain unavailable. Times are stored as Timestamp without converting legacy dates. Legacy commands and reads retain their compatibility path. Legacy invitation/rename commands cannot mutate v2 teams.

The native support directory uses `listLegacyTeams` to paginate and filter the legacy collection on the server; direct collection listing is denied so v2 teams cannot leak into unscoped support UI. Ordinary users cannot call this support endpoint. A broad page may contain no legacy records and still have a next cursor; the adapter continues pagination. Existing support entry into legacy teams remains unchanged. Deploy this callable before the corresponding native adapter and rules cutover; older support binaries' broad query will be denied. No migrations, guardian grants, tenant UI, agenda reads or production changes are part of Step 3.

## Step 5 participant commands

See [participant boundaries](participant-boundaries.md) for callable payloads, actor scope, revisions, rollout gates, atomic projections and operational limits. `participants.test.mjs` exercises the actual callable handlers and rules with synthetic household identities. Household UI and expanded account deletion remain later steps. No native screens/adapters change, so UI evidence is not applicable.

## Phase 2 operational foundations (P2.01)

The Phase 1 interfaces were rechecked against merged `main` at `eec291f452374743701eb6fed25a0bb8fe629a8e` (PR #24). Existing organization commands, participant/guardian permissions, roster/history, self-only participant links, callable household agenda, calendar subscriptions, email fallback and resumable deletion remain the baseline. PR #23 staging acceptance is separate and was not adopted. The planning document's `d66e89b` source inventory is historical: events already have canonical v2 callable writes and server-derived scope; do not reintroduce client writes.

`shared/operations.ts` defines JSON operational event and status contracts. `src/firebase/operationalEvents.ts` maps validated canonical UTC timestamps to native Dates without initializing Firebase. This reader is available for P2.02 but is not connected to screens, queries or writers. Its caller supplies authorized canonical hierarchy/team records; decoding is not an authorization or publication visibility check. Phase 1 null publication markers remain readable. Missing Phase 2 metadata produces null matchup/venue/history and schedule version one, without guessing a legacy timezone, end time or resource. Facility/resource existence and organization ownership require server checks when P2.03 introduces those records.

The existing legacy `mapEventDoc` keeps split date/time, revision-zero compatibility and soft-deletion semantics. Explicit unit tests cover Timestamp, Date, ISO callable and epoch representations. It does not interpret cancellation as deletion or invent UTC starts/ends. Lifecycle writes, multi-team UI and publication commit-marker enforcement remain P2.02/P2.07 work.

`functions/src/operations/access.ts` centralizes the existing live canonical staff, program, hierarchy and every-team coach checks; Phase 1 policy imports remain compatibility exports. Operational helpers reject empty/duplicate team sets and malformed string role grants. `operations/revisions.ts` rejects stale, malformed and exhausted revisions using supported callable codes. `operations/requests.ts` preserves Phase 1 request identities and fingerprints byte for byte, including array order. Request IDs are scoped by authenticated actor, command and existing organization prefix. Command callbacks must recheck current authority before replay; external side effects must never run inside transaction callbacks. Receipts remain server-only in `commandRequests` with `uid` ownership so existing deletion cleanup continues to remove them. No new user-linked storage path is introduced.

Run `yarn test:operations` for the focused Phase 2 gate. It uses the same isolated `firebase.emulators.json`, demo project, loopback hosts and credential stripping as `yarn test:backend`, and always includes real account-deletion suites. The full backend job still runs every suite, including operational helper tests. Run `yarn test:contracts`, `yarn typecheck`, native coverage and the Functions build as well. No emulator configuration or security rules need duplication. No deployment, production access or staging index verification is performed by these tests. UI evidence is not applicable for this foundation-only step.
