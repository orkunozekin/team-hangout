# Phase 3 contracts and isolation

Phase 3 Step 1 locks pure contracts and synthetic isolation fixtures without enabling any Phase 3 feature. It adds no callable, client adapter, screen, organization flag, deployment, migration or production access.

## Verified prerequisite contracts

The Step 1 audit used `9b5fbc545e9602eef6b08db1d8a0078a34a0731c` from `main`.

- Canonical matches retain one event ID, at least one `teamIds` entry and `teamId = teamIds[0]`. A competition match has exactly two explicit same-organization sides, with `homeTeamId` and `awayTeamId` matching the canonical order.
- Participants remain organization-local IDs under `organizations/{orgId}/participants/{participantId}`. Guardian UIDs and linked account UIDs are relationships, never participant identity.
- Completion snapshots under `events/{eventId}/rosterSnapshots/{participantId}` preserve the attendance denominator. Missing attendance remains unknown.
- Facilities and resources retain organization scope and immutable availability history. Phase 3 reporting must preserve the effective revisions it consumes.
- Organization membership, program scope and team coaching assignments are canonical authority. Platform support roles, navigation projections and guardian relationships grant no coaching or competition capability.
- Mutable operations use a client `requestId`, nonnegative `expectedRevision` and a canonical resource ID. A mismatched revision is `STALE_REVISION`; tenant, hierarchy, event and team scope is immutable.

Phase 2 push credentials and physical-device delivery remain parallel pilot and release gates. They are not prerequisites for these contracts or emulator fixtures.

## Pure contracts

`shared/phase3.ts` contains no Firebase import or runtime initialization. It provides:

- a strict mutation envelope and stale-revision validator;
- immutable organization, program, season, event and team scope checks;
- exact organization-local participant references that reject UID-shaped substitute fields;
- canonical two-side competition event validation;
- named capabilities derived from canonical active organization and team grants.

The capability resolver deliberately gives organization staff no coaching capability. Active team coaches receive team-scoped coaching, playing-time, practice-plan, result-proposal, volunteer and team-report capabilities. Active scoped staff receive competition, result-finalization, organization-report and practice-resource capabilities; only organization administrators receive rollover capability. Revoked, foreign-organization and guardian-only grants return none. Future handlers must load these canonical grants in the same server transaction or authorization boundary before calling the pure resolver. Clients never submit capabilities as authority.

## Synthetic isolation fixture

`phase3IsolationFixture` in `tests/backend/fixtures.mjs` contains only synthetic data:

- two organizations and two guardians;
- one coach who is also a parent;
- one revoked coach;
- two same-organization teams sharing one canonical match;
- one foreign team;
- active and archived seasons;
- independent participant IDs, attendance, a frozen roster snapshot and a versioned facility/resource boundary.

The fixture intentionally uses participant IDs that differ from every authentication UID. It is safe only for the isolated emulator project.

## Deny-first storage boundary

Firestore rules explicitly deny direct client reads and writes for all proposed Phase 3 coaching, lineup, play-session, volunteer, ride, competition, report, rollover, practice-resource and practice-plan paths. Later steps may expose narrowly authorized callables or sanitized views, but a parent event read, platform role, guardian link or feature flag never grants access by itself.

Run the focused suite only through the explicit emulator harness:

```bash
yarn test:operations
```

The harness strips project aliases, ADC and credential overrides, selects project `demo-team-hangout`, binds loopback Auth, Firestore, Functions and Storage emulators, and fails before database access when the required emulator environment is absent. Emulator success does not prove staging indexes, deployment or production readiness.
