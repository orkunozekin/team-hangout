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
