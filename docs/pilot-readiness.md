# Pilot readiness ledger

As of 2026-10-31, main at `09de28b`. This page collects the gates from `docs/phase-1-pilot-runbook.md`, `docs/phase-2-pilot-runbook.md` and `docs/features/phase-3-coaching-competition-feature-plan.md`, together with this round's agent results. Nothing is marked done without evidence. Production (`team-hangout-ddf27`) was not changed by any of this work.

Statuses: **Done** (evidence linked), **In progress** (work open or partly proven), **Blocked** (cannot continue without a credential or an external input), **Owner decision** (needs the owner's choice or approval).

## Open PRs from this round

| PR | Scope | Head |
| --- | --- | --- |
| [#68](https://github.com/orkunozekin/team-hangout/pull/68) | Staging deploy parity evidence and `docs/production-release-checklist.md` | `108ad0c` |
| [#69](https://github.com/orkunozekin/team-hangout/pull/69) | Native QA pass: button text scale cap and attendance spacing, backlog update | `e801e65` |
| [#70](https://github.com/orkunozekin/team-hangout/pull/70) | Live legacy migration tool (`scripts/migrations/legacy-live.mjs`) with emulator tests | `6715822` |
| [#71](https://github.com/orkunozekin/team-hangout/pull/71) | Staging ops drill evidence and remaining steps | `5935e73` |

None of these is merged. The capacity agent opened no PR because the owner's recorded hold applies (see below).

## Gate table

| Phase | Gate | Status | Evidence and what remains |
| --- | --- | --- | --- |
| 1 | Staging project and indexes | In progress | Staging redeployed from `09de28b` with exit 0: 182 functions ACTIVE, 61 of 61 composite indexes and 14 field overrides match source, all 4 secrets exist ([#68](https://github.com/orkunozekin/team-hangout/pull/68)). READY state per index not verified; owner console check needed. Hosting not redeployed. |
| 1 | Capacity (agenda p95, two 5,000-row imports on staging) | Owner decision | Local subset only. Not run on staging because the owner's recorded hold ("Large 5,000-row imports remain on hold until cost estimation and usage review") still applies. Rough estimate for one run is about $0.40 to $2 in Firestore. Needs the hold lifted and approval to create synthetic `@example.test` Auth users on staging. |
| 1 | Migration | In progress | Live tool with dry-run, checksum, resume, replay and reconcile; 8 of 8 emulator tests pass ([#70](https://github.com/orkunozekin/team-hangout/pull/70)). Staging rehearsal and production read-only dry-run blocked on Application Default Credentials. Mapping manifest and writer-stop window need owner approval. |
| 1 | Native and browser accessibility | In progress | Simulator pass fixed button text breaking at XXXL ([#69](https://github.com/orkunozekin/team-hangout/pull/69)). Open: VoiceOver and TalkBack sessions, Android, card heading word breaks at XXXL, and the browser screen-reader and keyboard session the Phase 1 runbook requires (organization hierarchy and staff editor, roster and guardian revocation, invitations and focus return, CSV mapping and confirmation, event information, email preferences). |
| 1 | Calendar clients | In progress | macOS Calendar evidence from Phase 1 Step 11; staging `calendarFeed` returns 404 for missing or invalid tokens ([#71](https://github.com/orkunozekin/team-hangout/pull/71)). Real iOS, Google and Outlook fetches, UID stability and rotation not run. |
| 1 | Email | Owner decision | Development mailbox only. Needs provider, sender, SPF/DKIM/DMARC, privacy URL and opt-out policy. Production deploy also needs `ESSENTIAL_EMAIL_API_KEY` or a code change, since the worker is only auto-skipped on staging. |
| 1 | Privacy and retention | Owner decision | Youth/guardian identity and contact policy, import and private-plan retention, deletion and residual copies pending. Defaults in code are not legal acceptance. |
| 1 | Monitoring and support | Owner decision | `monitorPhase2Pilot` runs every 5 minutes on staging with no alerts; `monitorPhase3Pilot` is deployed ([#71](https://github.com/orkunozekin/team-hangout/pull/71)). Monitor enablement and alert triggering not run (no staging credentials). Release, support and on-call owners not named. |
| 1 | Pilot enrollment and rollback | Owner decision | No partners named, no flags changed. Rollback flag flip drill blocked on staging credentials. |
| 1 | Commercial restrictions | Owner decision | Business model not selected; no paid gates introduced. |
| 2 | Staging indexes (attachments, schedule operations) | In progress | Deployed and matching source ([#68](https://github.com/orkunozekin/team-hangout/pull/68)); READY not verified. |
| 2 | Upload secret `ATTACHMENT_UPLOAD_KEY` | Done (staging only) | Exists on staging, v1 ENABLED ([#68](https://github.com/orkunozekin/team-hangout/pull/68)). Production secret is an owner step in the release checklist. |
| 2 | External scanner | Owner decision | Optional; not configured. |
| 2 | 10 MiB attachment drill | Blocked | Needs seeded synthetic data and staging Admin credentials ([#71](https://github.com/orkunozekin/team-hangout/pull/71)). |
| 2 | Attachment scanner, expiry and quarantine drills | Blocked | Required before `features.attachments` by the Phase 2 runbook "Secrets and scanner drills": scanner `unavailable` yields `SCAN_FAILED`, a reservation finalized after five minutes yields `EXPIRED` (including the crash-recovery case), and two `purgeAttachmentQuarantine` runs clear 24-hour-old orphans without touching ready rows. Not run on staging; needs credentials and synthetic data. The 10 MiB drill and the optional external scanner do not replace these. |
| 2 | Retention (attachments, conversations) | In progress | Product owner accepted 12 months after season end on 2026-10-21. Automated purge and hold workflow remain a production-expansion gate. |
| 2 | Youth history | Done | Product owner accepted on 2026-10-21 (see Phase 2 runbook). |
| 2 | Push and email delivery | Owner decision | Expo project, APNs, FCM, verified sender, bounce webhook and physical-device receipt tests pending (P2.14). |
| 2 | Native QA backlog | In progress | 2026-10-31 simulator pass recorded in `docs/phase-2-ui-qa-backlog.md` ([#69](https://github.com/orkunozekin/team-hangout/pull/69)). Open: P2.11, P2.12, P2.14, P2.18, P2.19 need real devices; P2.15 to P2.17 not seeded; in-progress matches drop out of Upcoming (needs an owner call and a backend change). |
| 2 | Monitoring | In progress | Staging email channel and log policies installed 2026-10-21; functions deployed ([#68](https://github.com/orkunozekin/team-hangout/pull/68)). Config enablement, alert drill and email channel verification remain. |
| 2 | Account deletion resume drill | Blocked | Needs staging credentials and synthetic users ([#71](https://github.com/orkunozekin/team-hangout/pull/71)). |
| 2 | Pilot partners | Owner decision | Not approved. |
| 2 | Commercial | Owner decision | Still pending. |
| 3 | Dependency contracts and private-access isolation | Done | Emulator suites listed in the Phase 3 acceptance record. |
| 3 | Lineup save/reload with screen reader and large text | In progress | Save/reload emulator-proven; lineup editor checked on the iOS simulator ([#69](https://github.com/orkunozekin/team-hangout/pull/69)). VoiceOver and TalkBack on the real editor not run. |
| 3 | Private notes and playtime privacy | Done | Emulator suites `lineups`, `playtime`, `phase3-contracts`, `phase3-rehearsal`. |
| 3 | Clock, corrections, standings, brackets | Done | Emulator-proven per the Phase 3 acceptance record. |
| 3 | League rules for standings | Owner decision | Administrator-approved competition rules per pilot organization are an external gate. |
| 3 | Volunteers and rides | Owner decision | Capacity and consent emulator-proven. Rides stay disabled until an organization records a real transport policy and coordinator. |
| 3 | Reports and exports | Done | Hand-calculated corpus and CSV neutralization tests per the acceptance record. |
| 3 | Rollover | Done | Emulator-proven with 201 teams, crash, edit and revocation. |
| 3 | Practice resources | Owner decision | Rights and reviewer gate enforced in code with synthetic fixtures only. Real rights evidence and a qualified reviewer are organization-owned. |
| 3 | Native UI evidence for Phase 3 screens | In progress | One native simulator capture in [#69](https://github.com/orkunozekin/team-hangout/pull/69); Steps 3 to 13 had web captures only. Android not covered. |
| 3 | Pilot deploy prerequisites (rules, indexes, functions) | In progress | Applied on staging from `09de28b` ([#68](https://github.com/orkunozekin/team-hangout/pull/68)). Not applied to production. |
| 3 | Native client rebuild (`react-native-svg`, gesture handler, `expo-sharing`) | Owner decision | Store builds not made. Needs a release owner. |
| 3 | Per-capability flags for coaching, results, brackets, volunteers | Owner decision | No per-organization flag exists; needs a flag or a release decision. |
| 3 | Season rehearsal and `monitorPhase3Pilot` | In progress | Synthetic rehearsal passes in emulators; monitor deployed on staging but not enabled or drilled. |

## Path to pilot

1. Merge PRs #68, #69, #70 and #71 after review and green CI.
2. Owner confirms every staging index is READY in the Firebase console.
3. Owner provides staging Application Default Credentials, then run the staging migration rehearsal and the blocked ops drills (monitor enablement and alerts, 10 MiB attachments, the attachment scanner-failure, upload-expiry and quarantine-purge drills, deletion resume, calendar UID rotation, rollback flip). Keep `features.attachments` off until all attachment drills pass.
4. Owner decides on the capacity hold; if lifted, run the agenda p95 and both 5,000-row imports on staging.
5. Human tester completes VoiceOver, TalkBack, Android and physical-device rows (push, GPS, storage, document picker), plus the browser screen-reader and keyboard session for the admin workspace.
6. Owner settles the policy decisions below (privacy, email, push, league rules, transport, practice resources).
7. Owner approves the release SHA and follows `docs/production-release-checklist.md`: secrets, deploy order, then the read-only production migration dry-run.
8. Owner approves the migration window and apply, then enables flags one organization at a time for named partners, with the rollback plan accepted.

## Owner decisions needed

- **Release owner**: who approves the release SHA, production secrets and store builds.
- **Support and on-call owner**: named contacts for the monitoring escalation, plus verification of the alert email channel.
- **Pilot partners**: which organizations, in what order, and which flags for each.
- **Privacy and retention policy**: youth and guardian contact policy, import and migration plan file retention, `IMPORT_RETENTION_DAYS`, deletion and residual copies.
- **Email provider and sender**: provider, domain, SPF/DKIM/DMARC, privacy URL, opt-out policy, and `ESSENTIAL_EMAIL_API_KEY` for production.
- **Push credentials**: Expo project, APNs and FCM keys, and physical test devices.
- **League rules**: approved standings and tiebreak rules for each pilot organization.
- **Transport policy**: real ride policy evidence and a coordinator before rides can be enabled.
- **Practice resource rights and reviewer**: rights evidence for each resource and a qualified age and safety reviewer.
- **Commercial**: business model; no paid gates exist today.
- **Credentials and holds**: staging Application Default Credentials; whether the capacity hold is lifted; whether synthetic `@example.test` Auth users and seeded data may be written to staging.
- **Product calls from QA**: whether 1.5 is the right button text scale cap; whether in-progress matches stay in Upcoming.
- **Migration**: the approved mapping manifest and the writer-stop window.
