# Backend security and compatibility tests

Run with Node 22, Java 21 or later, and dependencies installed:

```sh
yarn install --frozen-lockfile
yarn --cwd functions install --frozen-lockfile
yarn test:backend
```

The runner builds Functions and starts Auth (9099), Firestore (8080) and Functions (5001) on loopback under `demo-team-hangout`, using the separate `firebase.emulators.json`. No Firebase login, production credentials, `.env.local`, or native Firebase initialization is needed. The Firebase CLI may download emulator binaries on first use. Stop any services using these ports first. Emulator state is disposable synthetic data. The test files require an explicit runner opt-in, demo project and exact loopback emulator hosts before initializing database clients. Files run serially because rules fixtures clear Firestore between tests.

`yarn test:contracts` runs pure boundary fixtures without emulators. `shared/contracts.ts` has no Firebase or native imports and is not used by live storage adapters yet. Timestamp JSON uses canonical UTC ISO strings with millisecond precision; sub-millisecond storage precision is intentionally truncated. The legacy date review decoder fails on missing or malformed input; live legacy mappers retain their current behavior until the later cutover/migration.

## Baseline expectations

The emulator suite tests deployed rule source and the real `deleteAccount` callable, rather than mocks:

| Surface | Step 1 expectation |
| --- | --- |
| Team creation | Client batch creates team, coach membership and invite lookup. |
| Player join | Current code lookup plus canonical player membership succeeds; missing active lookup denies join. |
| Event reads | Team members see non-deleted team events; unrelated team reads, broad queries and deleted events fail. Players cannot write events. |
| Invitation rotation | Coach replaces lookup and team code atomically; old lookup disappears and players cannot rotate. |
| Platform support | Super admin can list teams and manage legacy team/event data; self-promotion to platform admin fails. |
| Account deletion | Unauthenticated call fails; authenticated call removes own Auth/profile/memberships, preserves other identities and team/event history, and tolerates missing Auth user on retry. |
| Future tenant data | Organization/private-profile/navigation paths remain default-denied, including cross-org payloads and platform admins. |

Two tests intentionally assert **unsafe existing behavior**: unrelated signed-in team gets and self-created coach memberships that grant event writes. Passing these tests records the vulnerability, not security approval. Step 2 must replace these assertions with denial tests in the same atomic change that introduces server commands and closes the rules. Do not expose youth tenant data before that cutover.

Canonical contract fixtures independently reject mismatched organization/program/season/division references, cross-org event team sets, malformed roles/revisions/timestamps and invalid event lifecycle/publication values. These pure validators do not grant authorization, implement hierarchy commands, prove future tenant access, or prove production indexes. Later steps must test those policies against their actual handlers and rules.

CI runs both the existing native unit/coverage job and a separate emulator job without live secrets. UI evidence is not applicable to this test/contract-only change.
