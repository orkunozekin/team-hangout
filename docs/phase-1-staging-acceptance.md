# Phase 1 staging deployment and acceptance package

Prepared 2026-10-13 against merged PR #22, `11aa852a1fe70c272bdddf04d0f8856989684bd3`. **Not accepted, not pilot-ready.** The source inventory and pending-input table below retain the original preparation snapshot. Subsequent isolated staging installation and small synthetic smoke are recorded in the [deployment record](phase-1-staging-deployment.md), which supersedes this package for approved infrastructure configuration, artifacts and executed actions. Capacity workloads remain on hold for cost review. Use a newly reviewed candidate and fresh configuration/index inventories for any further deployment; the PR #22 hashes do not describe current main or the deployed staging artifact. This package specifies proposed actions; it grants no deployment, email, migration or rollout authority. See the [release runbook](phase-1-pilot-runbook.md) for retained local evidence and recovery rules.

## Approval request and scope

The first proposed external action is deployment of the existing candidate to one isolated Firebase staging project with synthetic data and named test accounts, not production or real pilot enrollment. Approval must identify project ID, project owner, billing/cost ceiling, Firestore location, actual Storage bucket, Hosting site/domain, stable calendar UID domain, allowed credentials/operator, and which setup/deploy/read/fixture/flag actions are permitted. No existing local `.env.local`, native service file or implicit Firebase alias is assumed to belong to staging.

Keep email globally disabled and all organization exposure flags off during infrastructure installation. A second explicit staging fixture approval permits synthetic organizations and canonical grants plus only the necessary per-org test flags; flags confer no authorization. Email provider procurement, DNS, secrets and controlled delivery need separate named approval. Actual migration data and production execution need separate approvals. Testers' calendar providers receive a private bearer schedule URL, which needs explicit test-account/provider approval.

| Owner input | Value/decision | Owner and date |
| --- | --- | --- |
| Isolated project ID and billing cap | Pending | Unassigned |
| Firestore location, Storage bucket, service account/IAM | Pending | Unassigned |
| Hosting site and HTTPS domain; Auth authorized domains | Pending | Unassigned |
| Stable calendar UID domain and feed HTTPS endpoint | Pending | Unassigned |
| Deploy/read/fixture/test-flag scope and permitted operator | Pending | Unassigned |
| iOS, Android and browser testers/devices/accounts | Pending | Unassigned |
| Release owner; support and on-call; incident channel | Pending | Unassigned |
| Provider/sender/reply/domain/privacy/contact/retention | Pending | Unassigned |
| Actual migration mapping reviewer and data authorization | Pending | Unassigned |
| Pilot organizations, exposure increments, success measures | Pending | Unassigned |

The [candidate source inventory](evidence/phase-1-preparation/source-manifest.json) records SHA-256 hashes of the merged configuration, rules, indexes, entry point and package/lockfiles. These are source hashes, not a built/deployed artifact. Deployment release IDs, function revisions and native build IDs remain empty.

## Artifact and configuration preparation

Use a clean reviewed checkout and Node 22/Java 21+. Preserve existing changes before switching branches. Install each package from its own frozen lockfile, run the runbook checks, and record exact Node/Java/Firebase CLI versions. Native builds require staging-specific Firebase service files/OAuth clients and rebuilds; do not install a binary using the repository's historic service files against staging without checking their project identity. Record native build identifiers, source SHA and staging config separately from the web artifact.

The staging browser build must use `admin/.env.local` based on `admin/.env.example`: all four Firebase public values from the approved staging web application, `VITE_FIREBASE_FUNCTIONS_REGION=us-central1`, `VITE_USE_EMULATORS=0`. Clear inherited Vite overrides before building. Public configuration belongs to the intended project; backend secrets never belong in Vite or Expo variables. Verify direct-route loading, real Auth project identity and callable requests in Codex's in-app browser after deployment.

Backend non-secret configuration belongs in `functions/.env.<approved-project-id>` per [Firebase environment configuration](https://firebase.google.com/docs/functions/config-env). Project-specific Functions environment files are now ignored by `.gitignore`; keep them private/untracked and never include them in a commit. Record a redacted configuration manifest, not credentials. Do not inherit emulator or credential overrides into deployment. Authentication for deployment is the expressly authorized staging operator, not arbitrary local default credentials.

| Configuration | Proposed staging value or constraint |
| --- | --- |
| `IMPORT_BUCKET` | Exact approved private bucket, including actual `.firebasestorage.app` or `.appspot.com` suffix; verify service access |
| `IMPORT_RETENTION_DAYS` | Owner decision 1–30; implementation default 7 is not acceptance |
| `CALENDAR_FEED_BASE_URL` | Actual deployed HTTPS `calendarFeed` URL, no query/fragment/userinfo; no SPA fallback |
| `CALENDAR_UID_DOMAIN` | Approved stable domain, recorded before client subscriptions |
| `ESSENTIAL_EMAIL_ENABLED` | `false` throughout initial infrastructure/capacity tests |
| `ESSENTIAL_EMAIL_POLICY_APPROVED` | `false` until dated policy acceptance |
| Other `ESSENTIAL_EMAIL_*` | No sender configuration until separate approval; see essential-email contract |
| `INVITATION_DELIVERY_KEY` | Backend Secret Manager 32-byte hex secret; provision only with approval |
| `ESSENTIAL_EMAIL_API_KEY` | Backend Secret Manager provider secret, bound by email worker even when disabled; whole-Functions deployment requires resolving this dependency |

If the owner does not approve provider-secret provisioning yet, propose a separately reviewed Functions deployment selection omitting `resumeEssentialEmail`; do not silently invent a key or claim the full backend is installed. Record omitted exports as a blocking email gate. `createInvitation`/`resendInvitation` still require their encryption secret. The demo mailbox cannot be used outside exact demo emulators.

`firebase.admin-staging.json` installs Hosting only. It has a catch-all SPA rewrite; **it does not proxy calendar feeds or Functions**. Browser callables use the configured region. The current Functions definitions use the default `us-central1` region; selecting another region requires code and review. Firestore location, deployed Functions memory/timeout/min/max instances/concurrency and quota limits must be captured from actual deployment, not inferred from source defaults.

## Ordered external actions after approval

These commands are review examples with required placeholders. Do not run them until scope is approved. Always pass the explicit staging project; do not use `firebase use` or an implicit alias. Use the pinned local Firebase CLI (`yarn firebase`). Abort if project identity differs from the approved record.

1. Owner creates or identifies the isolated project, enables billing/APIs and registers staging web/native apps. Owner/operator records Auth providers and domains, Storage bucket, location, service account permissions and cost alerts. No production project resources are shared. Confirm no real users or pilot data are copied.
2. Operator provisions only approved secrets through interactive Secret Manager tooling, never command-line literal values. Record secret resource/version identity without values. Build Functions and normal browser production mode with the approved configuration. Save source SHA, clean status, lockfile/config/rules/index digests and web/Functions file digests in a private immutable artifact manifest.
3. Install the checked-in indexes and Storage rules first:

   ```sh
   yarn firebase deploy --config firebase.json --only firestore:indexes,storage --project APPROVED_STAGING_PROJECT
   ```

   Wait for every required composite index to be READY and verify definition equality against `firestore.indexes.json`, including collection-group scope. Save dated index inventory and rules releases. The emulator and a successful CLI exit do not prove readiness. Preserve current single-field settings needed for outbox status/document-ID and reports. [Firebase index management](https://firebase.google.com/docs/firestore/query-data/indexing) describes index build status.
4. Install the approved Functions export set before restrictive Firestore rules, then rules, with exposure disabled:

   ```sh
   yarn firebase deploy --config firebase.json --only functions --project APPROVED_STAGING_PROJECT
   yarn firebase deploy --config firebase.json --only firestore:rules --project APPROVED_STAGING_PROJECT
   ```

   The whole-Functions example requires both approved secret dependencies above. Review any CLI proposed deletions or extra configuration before execution. Record each exported function's deployed revision, service account, trigger, region, resource settings and deployment timestamp. Verify Firestore `processRosterImports` Eventarc delivery; `resumeRosterImports`, `expireRosterImports`, `resumeAccountDeletions` five-minute schedules; and, only if approved/deployed, `resumeEssentialEmail` one-minute schedule and authenticated invocation identity. Shared roster workers process schedule jobs too.
5. Bind and deploy the approved Hosting site after a normal staging build:

   ```sh
   yarn firebase target:apply hosting admin-staging APPROVED_SITE_ID --project APPROVED_STAGING_PROJECT
   yarn --cwd admin build
   yarn firebase deploy --config firebase.admin-staging.json --only hosting:admin-staging --project APPROVED_STAGING_PROJECT
   ```

   Record resulting target mapping, release/version ID, HTTPS origin, web manifest hashes and deploy SHA. Verify Auth authorized domain and security headers/direct routes. Follow [Firebase multisite target configuration](https://firebase.google.com/docs/hosting/multisites). Default Hosting HTTPS is acceptable if the owner approves it; custom-domain DNS is separate authorization.
6. Before issuing any feed, configure and test bearer-URL logging exclusions/redaction across Cloud Run, load balancers, proxies, traces and diagnostics with synthetic tokens. No cache layer may retain feed content. Capture proof without saving a bearer in general logs/evidence. Verify actual feed endpoint gives ICS rather than the SPA and uses private no-store headers on successes/errors.
7. Only after explicit synthetic-fixture/test-flag approval, create canonical hierarchy, trusted owner/staff/guardian identities and scoped synthetic organizations. Review exact org IDs and before/after flag changes. Enable only tested capabilities for those orgs; keep `essentialEmail` off. Capture revoked/foreign/deleting actor denial before any functional acceptance. Do not reuse loopback-only seed/rehearsal scripts against staging.
8. Execute the acceptance protocols below. Stop at failed thresholds, disclosure, failed auth or missing index. Diagnose, implement a scoped fix PR and obtain new reviewed artifacts before rerunning. Record any deployment, config or flag change during a run as a new run boundary.

## Capacity protocol

Use authenticated HTTPS callable clients with real staging Auth tokens, never `.run`, direct Admin handler invocation or manual row resumes. Store tokens and private reports outside Git with mode 0600. Separate fixture creation, reconciliation and measured request windows so setup/read traffic is identifiable. Record candidate/deployed revision, timestamps, region, client device/network, topology, fixture hash and page size. Fixtures match the retained local workload: 20 teams, 93 days, 1,860 published events, two organizations and two independent guardian accounts with two children per organization. No mail-enabled organizations or contacts.

For agenda, record at least 20 sequential warm first-page requests for the same defined scope, all individual elapsed times and correctness results. Use nearest-rank p95 (`ceil(0.95*n)` after ascending sort), require strictly below 2,000 ms, and keep explicit cold samples separate. Identify cold invocations through service instance/startup telemetry after a verified new instance/revision or idle period; a first request alone is not proof of cold start. State sample counts and whether cold startup was actually observed. Run additional owner-approved concurrent callers separately; record contention, failures and fanout rather than mixing these into the warm baseline.

For each import type, upload exactly 5,000 unique synthetic rows through its HTTPS callable with reviewed mapping. Start the total clock immediately before upload; record upload/preview completion, explicit resolutions/confirmation, commit request, first worker start and terminal completion. Report both total wall time and active preview+commit time, with any operator review delay shown separately. Require preview+commit below 600 seconds; retain total wall time. Observe trigger and scheduler continuation without direct service resumes. Record job timestamps/checkpoints, lease acquisitions/expiry, duplicate trigger deliveries, worker instances, batches, queue wait distribution, attempts, concurrency and final created/updated/skipped/error counts. Reopen and reconcile deterministic IDs and a replay without duplicates. Schedule drafts stay staged; publication is a separate approved test.

Collect deployed Firestore document-read/write and index-entry work for the measured window from approved query diagnostics/usage/billing telemetry; record the method, baseline subtraction, delayed telemetry and attribution limits. Query Explain describes query plans and index entries, not all transactional billed work. Keep local transaction snapshot counts separate. Record measured function invocations/compute, trigger fanout, Storage operations and an owner-accepted estimated cost per agenda request and 5,000-row job. If accurate attribution is unavailable, cost acceptance remains blocked. Run one job first, then a separately approved overlapping-job/lease recovery test; state sample counts, not a throughput percentile from one import.

## Human acceptance sessions

Use the [session record](phase-1-acceptance-record.md) for each tester and [runbook workflows](phase-1-pilot-runbook.md#accessibility-record-and-required-manual-sessions). iOS VoiceOver, Android TalkBack and browser spoken screen reader/keyboard each need a named tester, actual device/OS/AT/browser/build, date, largest text and ordinary text, focus order, spoken output, errors/loading/expanded/disabled states and defects. Include software keyboard, destructive dialogs, dismissal and focus return, grant loss and empty/error states. A screenshot/AX tree or simulator preview cannot accept spoken usability. Retest each defect on the reviewed replacement build.

For iOS, Google Calendar and Outlook separately, use approved test accounts and minimal synthetic scope. Record subscription completion, client refresh setting, initial fetch, stable UID/SEQUENCE before/after title/time update, automatic and manual refresh times, duplicates, rotation old/new URL HTTP behavior, revoke/guardian-loss behavior and retained remote cache/removal. Never place tokens or URLs in shared evidence. A 404 proves server denial, not remote deletion. Preserve existing macOS evidence; do not substitute it for hosted-client sessions.

## Remaining implementation designs for separate review

Email: the repository has a Resend send adapter and service-only `recordDeliveryOutcome`, but no deployed signature-verifying webhook ingress. After provider/policy selection, implement raw-body signature verification with provider timestamp/replay rules and bounded payload handling, correlate provider message ID to the canonical outbox, restrict outcome types to bounce/complaint, deduplicate delivery and persist suppression atomically through the existing service contract. Test forged/stale signatures, unrelated IDs, duplicate/concurrent callbacks, cross-org contacts and suppression before resend. A verified callback needs provider receipts and actual controlled delivery as well as tests. Define authenticated operator disposition for ambiguous sends using provider lookup/acceptance evidence and original idempotency key/24-hour window; never automatically resend an uncertain acceptance. Review terminal payload/ciphertext retention, cleanup and privacy-safe monitoring before enablement.

Migration: preserve `scripts/migrations/legacy.mjs` demo-only guard. After explicit staging execution/mapping approval, build a separate staging entry point with an exact approved project allowlist, credential/project identity check, no emulator overrides, expiring owner-approved run manifest/checksum and maintenance/feature fence. Reuse core inventory/plan/apply comparison logic without widening the legacy CLI. Separate read-only inventory/plan, approval, apply/resume/replay/reconcile and reverse-checkpoint rollback; refuse unresolved mappings/orphans/DST/timezone ambiguity, changed pre/postimages/dependencies and plan/run reuse. Save private preimages/checkpoints under approved retention. Tests must prove production/wrong-project/refused credentials, drift, interruption/replay, access reconciliation and rollback refusal after legitimate edits. A reviewed staging path is still no production permission.

Monitoring: implement accepted privacy-safe queue-age/import checkpoint/deletion retry/feed/index/permission/disclosure alerts and route to named support/on-call. Threshold proposals are in the runbook. Record actual alert policy IDs, metric/query definitions, notification routes, test incident times/acknowledgment/escalation and recovery results. No user addresses, child names, feed/invite URLs or provider raw bodies in logs. Alert documents alone do not mean configured monitoring.

## Gate closure and rollout

Each gate gets its own acceptance record. Preserve failures as immutable evidence and link replacement runs. Require named owner, dated decision, exact build/deploy/config, scope and actual evidence; do not infer approval from tests, merge or AI score. Keep all release ledger rows open until accepted. Production deployment/migration, real email and pilot org exposure are separately approved actions.

Before pilot exposure, name partners, per-org increments and stop/rollback decision maker; approve measurable agenda latency/error, import completion, authorization/privacy, delivery and support response targets. Exercise stop exposure, revoke feeds/mail, preserve grants/history/checkpoints and restore only secure compatibility. No insecure legacy writes or blind data restoration. Select a business model separately; Phase 1 adds no paid restrictions. Later phases require a new instruction.
