# Browser admin workspace (Phase 1 Step 7)

The isolated `admin/` React/Vite application uses browser Firebase Auth and callable Functions. It imports only pure types from `shared/`, never native components, React Native, Expo or the native Firebase initializer. Native TypeScript excludes `admin/`. Each package has its own dependencies and lockfile; installing/building the native app does not require browser packages.

## Run and verify locally

Use Node 22 and Java 21+:

```sh
yarn install --frozen-lockfile
yarn --cwd functions install --frozen-lockfile
yarn --cwd admin install --frozen-lockfile
yarn --cwd admin playwright install chromium
yarn test:admin
```

`test:admin` compiles Functions and the production browser bundle with the synthetic `.env.emulator` mode. It starts the same loopback-only Auth/Firestore/Functions emulators as backend tests under `demo-team-hangout`, serves `admin/dist` on 127.0.0.1:4177, and runs real browser flows against actual callables. It refuses to seed without the runner opt-in and exact emulator addresses. Do not run it concurrently with `test:backend`: both own ports 9099, 8080 and 5001. Set `PLAYWRIGHT_CHANNEL=chrome` to use an already-installed Chrome instead of downloading a browser. Set `ADMIN_EVIDENCE_DIR` to retain screenshots outside source. CI provisions Chromium and runs the browser suite independently.

For manual demo work, start the loopback emulators, seed only synthetic fixtures through the local Admin SDK, and run `yarn --cwd admin dev --mode emulator`. The demo configuration has no production credentials. Emulator mode is explicitly enabled, requires a demo project and a loopback browser hostname, and never falls back to live services. A demo project without opt-in fails startup. Neither browser test nor app modifies production data.

For normal browser development, copy `admin/.env.example` to `admin/.env.local` and supply this app's intended staging Firebase public client configuration. Do not reuse another application's configuration or service credentials. Use `yarn --cwd admin build` for a normal production-mode bundle. Configuration is embedded at build time; the Vite mode `emulator` is for loopback testing only and must never be deployed. Missing configuration renders an explicit setup error.

## Access and behavior

Email/password sign-in uses the existing Firebase account and session-scoped browser persistence. Reset password uses Firebase's normal flow; it never creates an account or merges UIDs based on matching email. Provider-only account setup/linking remains an operator-guided Firebase process. The browser has no user directory; normal admin sign-in has no account registration surface. Step 9 adds invitation-only household registration.

The organization picker discovers canonical staff relationships. `/organizations/:orgId/{program,season,division,team,staff,organization}` reauthorizes on entry, reload, navigation and window focus through `getAdminWorkspace`. Focus preserves open edits and uncertain-action retry IDs when the canonical scope is unchanged; actual scope changes or denied access discard tenant state. A temporary focus-check connection failure retains edits, and saves still reauthorize server-side. Optional `?program=:programId` narrows scope; it grants nothing. Program staff must select an assigned program for seasons/divisions/teams. Organization and staff settings are admin-only. The canonical server policy checks every subsequent read and mutation. Platform support roles, guardian links, route state and discovery pointers do not confer staff access.

`getAdminWorkspace({orgId})` returns safe organization settings/revision and current staff scope, gated by the server-owned `features.adminWorkspace == true`. Enable only through a trusted server action after staging verification. Existing hierarchy commands still enforce `features.organizationV2`; the UI never enables rollout flags. A newly created organization requires separate owner approval for workspace rollout. `createOrganization` requires an existing trusted `organizationOwners/{uid}` grant and atomically creates its first administrator; the browser cannot adopt an existing organization.

`listOrganizationStaff({orgId,cursor?,pageSize?})` is admin-only and returns UID, roles, program IDs, status and revision, with a document-ID cursor and max page size 50. No email, participant profile, audit or unrelated account information is included. The workspace follows all pages of existing hierarchy/discovery APIs, fetching only each section’s records and required parents. Program/staff/settings entry does not await unrelated seasons or divisions. These reads use existing single-field/document-ID indexes; no new composite index is required. Deployment must include both new read callables before enabling the browser.

Hierarchy forms use `saveHierarchyEntity`, `saveTeam`, `setStaffAssignment` and `archiveSeason`. Parent references are immutable after creation. Deletion is reversible archiving, preserving history. Archived views include inactive records; archived seasons must be restored before detail edits. Staff forms assign or revoke an existing UID, never infer identity from names/email; choosing a role replaces the assignment's role selection. Self-demotion remains server-denied. Revoking staff clears access on the next canonical request, including completed-command replay.

Forms submit loaded revisions. Conflicts explain that the record changed and offer the workspace Reload action, which discards the stale editor. Request IDs belong to actions. An uncertain network failure retains the exact payload and request ID with disabled fields; “Retry same action” confirms the original action instead of creating another record. Other failures allow field corrections with a new action ID. Permission failures discard loaded records and editors. Auth changes unmount all tenant state; in-flight responses are ignored after unmount and checked against the initiating UID. No hierarchy data is written to browser storage or a persistent query cache.

## Staging Hosting

`firebase.admin-staging.json` is deliberately separate from the existing backend deployment configuration. It serves `admin/dist`, rewrites direct URLs to the SPA, and sets no-store, no-referrer, frame-denial and content-type headers. It names an unbound `admin-staging` Hosting target; this PR does not choose a live project, create a site, enable flags or deploy.

After the owner approves the intended staging project/site, configure the target with `firebase target:apply hosting admin-staging <approved-site-id> --project <approved-staging-project>`, add the Hosting domain to Firebase Auth authorized domains, build with that staging project's browser config, and deploy with `firebase deploy --config firebase.admin-staging.json --only hosting:admin-staging --project <approved-staging-project>`. Verify real staging callable reachability, Auth, index readiness and direct URLs before rollout. Do not publish the emulator build. Production deployment is a separate authorized operation.

Roster/household UI (Step 8), scoped invitation UI (Step 9), imports and calendars remain outside this step.

Step 9 adds administrator-only Invitations from workspace navigation and Participants. The invitation-only recipient route also supports household account creation, verified-email recovery and explicit acceptance without staff access. See [scoped invitations](invitations.md) for encrypted queued delivery and live domain/secret gates. Mail transport remains Step 14.

Invitation row actions use a keyboard-accessible kebab menu. The send button retains queued delivery status until email transport is configured. Display dates share Story Turn’s `Monday, Oct 12` format across browser and native screens; calendar-only values stay on their stored day, while invitation expiry timestamps display local time. Date input values retain their explicit ISO format.
