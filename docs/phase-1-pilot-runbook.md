# Phase 1 pilot release gates and recovery

Phase 1 is **not pilot-ready**. This runbook prepares a reviewable release decision; it does not authorize a deployment, production migration, live email, sender changes or pilot enrollment. Step 15 implements local accessibility corrections and executable synthetic rehearsals. Owner acceptance and the external evidence below remain incomplete.

## Staging preparation

The [staging deployment and acceptance package](phase-1-staging-acceptance.md) specifies the proposed isolated deployment, artifact/configuration record, index/scheduler verification, HTTPS capacity protocol, real accessibility/calendar sessions and separately reviewed webhook/migration paths. Copy [one acceptance record](phase-1-acceptance-record.md) per gate/session. Prepared 2026-10-13; project/domain/budget/operator approvals, testers and owners remain pending. No deployment, live email, migration or pilot exposure has been performed.

Step 15 PR #22 merged as `11aa852a1fe70c272bdddf04d0f8856989684bd3`. This closes local implementation/review, not external release acceptance.

## Evidence and repeatable local rehearsal

Use Node 22 and Java 21+ for CI parity. Local measurements used Node 26.3.0, Java 26, macOS 25.5.0 arm64, Apple M5 Pro with 18 cores and 24 GiB RAM. The Firebase project is the isolated `demo-team-hangout`; every service uses loopback. No region was measured. Backend default region `us-central1` is a configuration, not staging evidence.

```sh
yarn typecheck
yarn test --runInBand
yarn test:backend
PLAYWRIGHT_CHANNEL=chrome yarn test:admin
yarn --cwd admin build
# Stop other demo emulators first. Each output must be a new absolute path.
yarn rehearse:phase1 /private/tmp/phase1-rehearsal.json
# Independent subsets preserve expensive scale results after an operational fixture correction.
yarn rehearse:phase1 /private/tmp/phase1-operations.json operations
yarn rehearse:phase1 /private/tmp/phase1-scale.json scale
```

The runner removes inherited credential/project/emulator overrides, hardcodes the demo project and starts Auth, Firestore and Storage. The scenario entry refuses non-loopback hosts or credential overrides before database initialization. It invokes the real callable handlers via `.run`, the actual migration/worker functions and the actual feed handler over a local HTTP server. It drives imports in bounded 25-row service resumes; this measures processing time, **not deployed trigger fanout, queue latency, five-minute scheduler waits, HTTPS callable round trips or cold starts**. Firestore uses the checked-in rules/index file, but the emulator does not enforce production composite-index readiness.

Reports record source revision/dirty state, script checksum for new runs, hardware, sample size, timings, counters and explicit incomplete staging/owner gates. Output files use exclusive creation and mode 0600. Preserve full reports and failed attempts; never overwrite an evidence file or interpret a failed overall report as a successful end-to-end run. Committed sanitized results are in `docs/evidence/phase-1-step15/`.

The second scale attempt completed all three scale scenarios, then failed on a missing legacy timestamp in its synthetic migration fixture. A separate corrected operational attempt passed migration, feed/email revoke and deletion; the final guarded command passed again from clean `2489243` with its script checksum recorded. No backend implementation changed between those scale measurements and the correction. The original failed report is retained; independent scenario evidence is distinguished from whole-run success.

| Local scenario | Measured result | Sample and read work | Remaining proof |
| --- | --- | --- | --- |
| Agenda first page | Warm p95 1.101 seconds; first call 1.275 seconds | 20 measured warm samples plus one initial call; 20 teams, two organizations, two separate guardian Auth records with synthetic callable auth contexts, two children per org, 1,860 published events across 93 days, page size 20. 20,958 transaction document snapshots and 63 empty queries across 21 calls, approximately 998 snapshots/call. | Actual HTTPS latency including cold starts and network; production indexes and billed read/index-entry cost. |
| Roster 5,000 rows | Preview 116.42 seconds + commit 174.79 seconds = 291.22 seconds; 28.61 committed rows/second | One job, 25-row service resumes; 210,865 transaction snapshots and 10,000 empty queries, including replay. | Trigger fanout/cost, task pacing, concurrency and end-to-end staging completion under 10 minutes. |
| Schedule 5,000 rows | Preview 139.54 seconds + commit 103.13 seconds = 242.67 seconds; 48.48 committed rows/second | One job, 25-row service resumes; 155,995 transaction snapshots and 4,870 empty queries, including replay. Drafts remain staged, no outbox. | Same staging workload and publication/recipient-size limits; no automatic scheduling promise. |
| Reviewed migration | Six operations reconciled; interrupted after three, resumed, then replayed identical postimages | Mapped legacy team/event/member/invite, deterministic participant/roster; unmapped team unchanged; no-email manifest. Full backend suite adds multi-team, same-name, orphan, drift and DST cases. | Owner-reviewed real mapping, quiesced writers, retained private plans, staging rehearsal and separately reviewed execution tooling. |
| Revoke and deletion | Feed 200 then generic 404 without event data; revoked mail cancelled before send; account cleanup resumes after one page | Other guardian receives synthetic mailbox mail and retains 20-team access; child identity and organization event remain after parent Auth deletion. | Hosted clients, live provider/webhook outcomes and production deny-first/retention reconciliation. |

Transaction counters are SDK snapshots requested by handler transactions, including retries, repeated reads and missing documents; empty queries are counted separately. They exclude setup/reconciliation reads and worker reads outside transactions. They are **not billed reads**. The high repeated-read cost is a staging capacity/cost gate despite passing local timings. If staging fails either target, revise the implementation and rerun before making a pilot capacity promise. One import sample is not a throughput percentile.

## Accessibility record and required manual sessions

Corrections include named/busy/disabled shared native buttons, semantic headings, live native error regions, expanded calendar-filter state, darker normal-text colors, a browser keyboard skip link, focusable named table scroll regions, explicit column headers, 44px action targets and phone reflow. Visible text scaling remains enabled. Browser error and import progress regions already exist and are retained.

Browser automation audits ten organization routes plus calendar subscriptions, email preferences, help, invitation fallback and denied private-event information at 200% CSS zoom, with a 780px viewport (390px effective width). It verifies no document overflow, actionable targets, semantic table headers, keyboard-only editor submission, native required-field focus, and skip-link focus. This is CSS enlargement/reflow evidence, not a certification of every browser zoom mode. A separate Codex in-app browser session manually used Tab and Enter to focus and activate the skip link, verifying main-content focus through the accessibility tree. Installed headless Chrome is used because the local Playwright Chromium download is absent; CI installs Chromium.

The existing iPhone 17 Pro / iOS 26.5 development client loaded this managed checkout's Expo 54 Metro bundle at loopback port 8081. Native inspections covered household/agenda, filter expansion and invalid-date validation, participant actor/guardian/contact context, subscription privacy/empty state and unavailable invitation. Captures include the largest accessibility text category and `accessibility-medium` profile/subscription context; the invitation fallback was captured after restoring the original `large` category. Text wraps and scrolls; focusing the profile input brings it into view. The original simulator text category was restored. The largest household capture predates the clean implementation commit and has dirty-base provenance; profile/subscription captures belong to clean `5aed5a0`, the invitation capture uses the restored `large` text setting, and final browser captures belong to clean `2a2efbc`.

Native gesture automation returned `noWindowsAvailable`; some scrolled filter/error/subscription states could not be visually reached. Accessibility-tree exposure is **not a VoiceOver session**. The available tooling exposes neither native spoken output nor a native VoiceOver/TalkBack control; `adb` is absent and no Android emulator/device was demonstrated. No actual browser spoken screen-reader session was performed. These remain release-blocking external verification, not passing automated results.

Before acceptance, a named tester must record platform/device/app build, date, text setting, assistive technology/version, workflow, focus sequence, spoken labels/states/errors, actual result and defects:

- iOS VoiceOver and Android TalkBack: household and filters, revoked/empty/error states, participant edit confirmation and focus return, feed scope/create/rotate/revoke, invitation acceptance/unavailable, login and deletion.
- Browser screen reader and keyboard: organization hierarchy/staff editor, roster/private profile/guardian revocation, invitations/action popover and focus return, CSV mapping/resolution/confirmation/progress, event information and email preferences.
- Largest supported text and narrow phone viewport: long names, errors, forms with software keyboard, disabled/loading actions, all new screens and destructive confirmation. Retest any corrections; retain this PR's initial screenshots after review fixes and describe those fixes in text.

## Release decision ledger

Every row requires a named owner, dated decision and attached result. Empty owner/evidence cells mean **not accepted**. No combination of green CI or AI confidence substitutes for this ledger.

| Gate | Required evidence/action | Current status |
| --- | --- | --- |
| Staging project and indexes | Authorized isolated project, deployed artifact SHA, matching `firestore.indexes.json`, all indexes READY, Storage rules, Auth domains, region and resource limits. Read-only staging access must be demonstrably authorized. | Not available/verified; no deployment authorized. |
| Capacity | HTTPS agenda p95 under 2 seconds for 20 teams/93 days with at least 20 warm samples plus explicit cold samples; both 5,000-row imports finish preview+commit under 10 minutes with actual triggers/scheduler. Capture measured reads/index entries, cost, job fanout, queue wait, concurrency, region and hardware/client network. | Local subset only; staging incomplete. |
| Migration | Review ownership/timezones/default duration, unresolved/orphan counts and legacy coach assignments; stop writers; save checksum and private plan; rehearse apply/resume/replay/access reconciliation. | Synthetic local only. Existing migration CLI intentionally refuses staging/production; adapting it requires separate owner authorization and review. |
| Native and browser accessibility | Real manual sessions above, including dialogs and keyboard; fix defects before acceptance. | AX/unit/keyboard/enlarged-text subset only. |
| Calendar clients | Completed iOS subscription/refresh, Google and Outlook fetches from approved HTTPS endpoint, stable UID updates, rotations/revocations and retained remote-cache explanation. | macOS Calendar evidence exists from Step 11; real iOS final confirmation and hosted Google/Outlook acceptance remain incomplete. |
| Email | Approved Resend procurement/sender/SPF/DKIM/DMARC/quotas/region/secrets, privacy URL, opt-out/contact policy, authenticated correlated webhook processing, suppression and ambiguity reconciliation with provider receipts. | Development mailbox only; no live mail or sender change. |
| Privacy and retention | Owner-approved youth/guardian identity/contact policy, import/private-plan retention, deletion/pseudonymization and residual third-party copies. | Owner decisions pending. Defaults in implementation are not legal acceptance. |
| Monitoring and support | Named release/support/on-call owners, configured alerts and tested escalation/recovery below. | Runbook prepared; deployed alerting/ownership not verified. |
| Pilot enrollment and rollback | Named partners, per-org staged feature exposure, update-required communication, agreed measures and an accepted rollback plan. | Owner approval pending; no rollout flags changed. |
| Commercial restrictions | Business-model selection; no paid entitlement, ad or fee gate in this phase. | Selection pending; no restrictions introduced. |

## Recovery and escalation

Until ownership is assigned, stop rollout and retain evidence on any material incident. Proposed alert thresholds below need owner acceptance and actual monitoring configuration; this PR does not claim installed production alerts. Collect only organization/job/event/request correlation IDs, versions, timestamps, counts, checkpoint/status and redacted operational codes. Never capture participant names, contact addresses, private notes, invitation/feed URLs or provider raw errors in logs/support artifacts.

| Signal and proposed threshold | First response | Recovery evidence |
| --- | --- | --- |
| Import paused/needs-review, checkpoint unchanged >10 minutes, or growing queued jobs | Stop new uploads for affected organization; inspect owner canonical rights, target lifecycle and lease. Do not clear a live lease or rewrite row receipts. | Reopen saved job, review/refresh pending rows after restoring authorized access, then resume with original IDs. Reconcile created/updated/skipped counts and deterministic IDs. `runRosterImport` and scheduled resumes are service operations. |
| Essential outbox oldest queued >10 minutes, growing terminal failures, any ambiguous delivery | Stop essential-email exposure for affected org; inspect safe delivery status and provider evidence. No blind retry of `sending`/ambiguous messages. | Known pre-send failures use bounded backoff. After provider reconciliation, perform separately reviewed disposition; never regenerate invitations or resend to revoked recipients. See `essential-email.md`. |
| Account deletion pending >10 minutes or `CLEANUP_RETRY_REQUIRED` | Confirm deny-first job exists and canonical reads fail immediately; escalate to support owner. Do not re-enable account/grants. | Service `resumeDeletion` continues durable stage/cursor; Auth may already be absent. Reconcile feeds, invitation tokens, projections, endpoints, private source rows and grants; preserve organization history/other guardians. See `account-deletion.md`. |
| Any cross-org/private-field disclosure or unexpected permission-failure spike over baseline | Stop exposure immediately; preserve sanitized IDs/build/revision, investigate canonical grants/rules/deleting-state first. Revocation remains available to owners. | Reproduce with synthetic actor matrix. Repair forward through reviewed commands; never reopen permissive old-client writes or turn projections into authority. |
| Missing index, feed 503, repeated retry/lease contention | Keep affected capability disabled; inspect deployed index/resource/config readiness and size limits. Narrow scope only through explicit user selection. | Validate identical event IDs/UID/sequence and no partial feeds; test after resource/index repair in approved staging. |

Rollback first stops new exposure and new import/mail work for the affected org using separately authorized server-owned flags. Flags never grant authority. Already-created grants remain real, issued feeds need explicit revocation, and completed data/history must be retained safely. Restore read compatibility only through secure reviewed readers. Never reopen insecure legacy writes, overwrite later legitimate edits, discard audit checkpoints, or claim removal of emails/calendar entries already copied to third-party applications. A pre-edit migration data rollback requires reverse checkpoint order, exact current `after` match and a separate audit/run ID; after edits, repair forward. See `legacy-migration.md`.

## Owner acceptance record

Release owner: **unassigned**. Support/on-call owner: **unassigned**. Pilot organizations/partners: **not approved**. Artifact/deploy SHA: **not deployed**. Staging evidence links: **none**. Policy/retention approval: **pending**. Accessibility tester/session links: **pending**. Calendar/email external acceptance: **pending**. Accepted rollout/rollback decision and date: **pending**.

Do not mark Phase 1 complete or pilot-ready until this record and every blocking ledger row contain actual accepted evidence. Later phases require a new user instruction.

Local verification on 2026-10-13: native typecheck and all 124 native tests, all 121 backend emulator cases, all 25 browser scenarios and normal production browser/Functions builds passed. A subsequent focused two-case browser run confirms real ArrowRight scrolling of enlarged table regions. Initial nine inspected screenshots are attached to [PR #22](https://github.com/orkunozekin/team-hangout/pull/22); checkout/platform/hash/asset/caption provenance is retained outside source in this chat's `step15/manifest.json`. Macroscope skipped both checks because credits are exhausted; that is not approval. Final PR CI/review remains authoritative.

Greptile review corrections add populated participant/roster/invitation and actual roster/schedule preview coverage, require their table regions, measure 44px height at an unzoomed 390px viewport, and retain a readable mode-0600 report on injected fixture-setup failure. Three executable safety/report regressions and both enriched browser scenarios pass. Initial image hashes remain unchanged; these later fixes are validated in text/tests.

Implementation review: Greptile explicitly scored `5fcebb9` 5/5 with zero new findings, all three bot threads resolved and all three CI jobs passing. CI verifies 124 native tests, 124 backend cases, 25 browser scenarios and successful operational evidence on Node 22.23.3; the report source checksum matches the implementation and its pilot-ready gate remains false. Final documentation-head verification and the scoped merge are recorded in PR #22. Owner acceptance remains pending.
