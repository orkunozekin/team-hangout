# Staging operations drills, 2026-11-03

Project: team-hangout-staging only, running main at `c82303e`. Production (`team-hangout-ddf27`) was not read or written. Credentials: Application Default Credentials (authorized user, quota project `team-hangout-staging`) through the Admin SDK; every client and command named `team-hangout-staging` explicitly. No live email or push was sent (the drill organization has `notificationPush` and `notificationEmailFallback` off). Capacity workloads (agenda p95, 5,000-row imports) were not run because the owner's cost hold still applies. This finishes the drills that `staging-ops-drills-2026-10-31.md` left blocked on credentials.

Synthetic data uses IDs prefixed `drill-` and the tag `drill: staging-ops-drills-2026-11-03`. Auth users: `drill-member-20261103@example.test` (org admin, coach and guardian in the drill organization) and `drill-delete-20261103@example.test` (deleted by the drill itself). The drill organization is `drill-org-20261103`. Feed tokens, upload tokens and passwords were never printed or committed.

## Result summary

| Drill | Result | Numbers |
| --- | --- | --- |
| Migration rehearsal | Pass | Orphan dry-run exit 2 and apply refused; clean dry-run exit 0; apply `--max-operations 5` wrote 5 of 11; resume completed 11 of 11 with reconcile ok; replay rewrote nothing; `--reconcile` ok, 0 mismatches |
| Phase 2 monitor alerts | Pass | All four codes logged by the scheduled `monitorPhase2Pilot` run at 19:47:07Z |
| Phase 3 monitor alerts | Pass | All eight codes logged by the scheduled `monitorPhase3Pilot` run at 19:59:11Z, count 1 each |
| 10 MiB JPEG and PDF | Pass | 10,437,548-byte JPEG and 10,440,265-byte PDF reserved, uploaded, finalized `ready` by the content scanner and downloaded with matching SHA-256 |
| Scanner `unavailable` | Pass | Row `rejected` with `SCAN_FAILED`, download 404, quarantine object removed; scanner config restored to missing |
| Upload expiry | Pass | Expired reservation finalized as `EXPIRED`, download 404. Crash case (`canonicalizing` plus matching `/2`) finalized `ready`, download bytes match |
| Quarantine purge, two runs | Pass | Run 1 saved an `objectPageToken`, run 2 cleared it and removed both orphans; the ready row's `/2` stayed |
| Calendar feed | Blocked | `createCalendarSubscription` returns `failed-precondition` "Calendar subscriptions need administrator endpoint setup.": staging functions have no `CALENDAR_FEED_BASE_URL` or `CALENDAR_UID_DOMAIN` |
| Account deletion resume | Pass | Interrupted after 25 of 40 memberships; scheduled `resumeAccountDeletions` completed it at 19:52:19Z (40 removed, 28 pages, 2 attempts), Auth user gone |
| Rollback flag flip | Pass | `applyPilotRollback` turned the four enabled writer flags off, quarantined the in-flight publication, and the documented stops held; flags flipped back |

## 1. Migration rehearsal

Synthetic legacy dataset (no `orgId`, no `schemaVersion`): team `drill-legacy-team` with invite lookup `DRLQ2345`, three users (`drill-legacy-coach`, `drill-legacy-player-1`, `drill-legacy-player-2`), three memberships (one coach, two players), two events (2026-11-20 18:00 and 2026-11-22 10:30 local labels), and one orphan membership `teamMembers/drill-legacy-missing-team_drill-legacy-ghost` whose team and user do not exist. The manifest maps the team to `drill-org-20261103` / `drill-program` / `drill-season` / `drill-division`, `America/Chicago`, 90 minutes, `confirmedBy: drill-operator`. Manifest and plan files were mode 0600 in a private scratch directory, never in the repository.

The inventory covers the whole staging project: 3 teams, 5 memberships, 4 events, 1 invite lookup, 8 users at the clean dry-run.

| Step | Exit | Time | Result |
| --- | --- | --- | --- |
| Dry-run with orphan | 2 | 2.7 s | 11 operations, 0 blocking issues, 1 orphan (the seeded path) |
| Apply of the orphan plan | 1 | 0.6 s | Refused: "Review blocking rows/orphans first". Nothing written |
| Dry-run after removing the orphan | 0 | 2.5 s | 11 operations, 0 issues, 0 orphans. Checksum `1559f618...4d8` |
| Apply `--max-operations 5` | 0 | 2.7 s | `complete: false`, 5 of 11 |
| Resume (same command, no limit) | 0 | 5.0 s | `complete: true`, 11 of 11; reconcile ok: 3 members, 1 coach, 2 players, 0 mismatches |
| Replay | 0 | 4.4 s | Same result, nothing rewritten |
| `--reconcile` | 0 | 1.1 s | ok, 0 mismatches |

Target counts: 1 team, 1 invite lookup, 3 memberships, 2 participants, 2 roster entries, 2 events. Run ID `legacy_70fb3760dfea254df10cc1f3426c961d42c4d08b`; checkpoints are under `legacyMigrationRuns/` on staging.

## 2. Monitoring

Previous state: `platformConfig/phase2Monitoring` was already `{ enabled: true, organizationIds: ["phase2-staging-drill-20261021"] }` from the 2026-10-21 install; `platformConfig/phase3Monitoring` did not exist. During the drill Phase 2 monitored both organizations and Phase 3 was `{ enabled: true }` (it has no organization scope; it counts tenant paths across staging). Both were restored afterwards: Phase 2 to the exact previous document, Phase 3 deleted.

Phase 2 seeds in `drill-org-20261103`: one `promoting` publication 27 minutes old, three `SCAN_FAILED` rows within the last minute, one `pending` deletion job 27 minutes old and one `complete` job with `lastError: CLEANUP_RETRY_REQUIRED` (both under `accountDeletionJobs/drill-monitor-*`). The scheduled run at 2026-11-03T19:47:07Z logged, at severity ERROR:

| Code | Count | `monitoredOrganizations` |
| --- | --- | --- |
| `PUBLICATION_STUCK` | 1 | 2 |
| `DELETION_STUCK` | 1 | 2 |
| `SCAN_FAILED_REPEATED` | 3 | 2 |
| `CLEANUP_RETRY_REQUIRED` | 1 | 2 |

No user IDs, file names or content appeared in the entries. `resumeAccountDeletions` ran two seconds later (19:47:09Z) and completed the seeded pending job, so `DELETION_STUCK` is only observable when the job is older than 10 minutes at the moment the monitor runs before the resumer; a job the resumer keeps retrying refreshes `updatedAt` and surfaces as `CLEANUP_RETRY_REQUIRED` instead. The Cloud Monitoring log policies installed on 2026-10-21 match these entries, so the staging alert channel may have received notifications for this window.

Phase 3 seeds in `drill-org-20261103` follow `tests/backend/phase3-monitoring.test.mjs` without `schemaVersion`, so the report, rollover and standings workers and reconcilers ignore them. The abandoned-build sweep in `reconcileStandings` (every 10 minutes) did fail the seeded `building` generation at 19:50Z as designed, so it was reseeded at 19:51Z ahead of the next monitor run.

The scheduled run at 2026-11-03T19:59:11Z logged, at severity ERROR, one entry per code, each `count: 1, truncated: false`: `STANDINGS_STALE`, `STANDINGS_BUILD_ABANDONED`, `REPORT_QUEUED_STUCK`, `REPORT_LEASE_EXPIRED`, `REPORT_FAILED`, `ROLLOVER_QUEUED_STUCK`, `ROLLOVER_LEASE_EXPIRED`, `ROLLOVER_FAILED`. The entries carry only code, count and truncation. The earlier run at 19:44:07Z ran 10 seconds before the config was enabled and logged nothing. Operators should note the staging cadence: Phase 3 runs near :14/:29/:44/:59 and the standings sweep at :00/:10/..., so a real abandoned build is normally swept before it can alert.

## 3. Attachments

All transfers ran as `drill-member-20261103` through the deployed `createAttachmentUpload`, `attachmentTransport` and `finalizeAttachment` in team scope `drill-team-20261103`.

| File | Bytes | Upload | Finalize | Download | Result |
| --- | --- | --- | --- | --- | --- |
| JPEG (noise image, metadata stripped) | 10,437,548 | 200, 6.8 s | 5.7 s, `ready`, `image/jpeg`, content scanner `clean`, canonical 10,437,530 bytes | 200, 2.3 s, 10,437,530 bytes | SHA-256 matches |
| PDF (one JPEG page) | 10,440,265 | 200, 1.4 s | 2.1 s, `ready`, `application/pdf`, `clean` | 200, 1.9 s, 10,440,265 bytes | SHA-256 matches |

The first JPEG call includes a cold start (20.6 s end to end; the PDF took 6.0 s).

Scanner drill: `platformConfig/attachmentScanner` was missing (built-in `content`). Set to `unavailable`, a JPEG finalized `rejected` with `SCAN_FAILED` (not `INTEGRITY` or `ACCESS_REVOKED`), download 404, quarantine object `/1` deleted. The document was then deleted again, so the scanner is back to its previous state.

Expiry drill: a reservation with bytes uploaded and `expiresAt` moved into the past finalized `rejected` / `EXPIRED`, download 404. The crash case (row left `canonicalizing`, object `/2` whose hash equals `canonicalSha256`, `expiresAt` past) finalized `ready` and the downloaded bytes equal the canonical object.

Quarantine purge: GCS creation times cannot be backdated, so the two runs called the deployed code's `purgeAbandonedAttachments` from the operator machine against staging with a clock that ages only the drill objects (`quarantine/drill-org-20261103/drill-orphan-a/1`, `.../drill-orphan-b/2` and the ready crash-case row's `/1` and `/2`); every other object kept its real creation time. With 6 quarantine objects and a page size of 3:

| Run | Time | `objectPageToken` | Orphans | Ready `/2` |
| --- | --- | --- | --- | --- |
| Before | | null | both present | present |
| 1 | 0.8 s | saved (132 chars) | both present (later page) | present, row `ready` |
| 2 | 1.1 s | null again | both deleted | present, row `ready` |

The hourly scheduled `purgeAttachmentQuarantine` keeps running on staging with its default pages.

## 4. Calendar feed

Blocked. Seeding worked (guardian link to `drill-child` on `drill-team-20261103`, two published events), but `createCalendarSubscription` fails with `failed-precondition` because the deployed staging functions have no `CALENDAR_FEED_BASE_URL` and `CALENDAR_UID_DOMAIN`. Outside the demo emulator the code refuses to issue a feed without both, which is the intended fail-closed behavior. Setting them needs an owner-approved HTTPS feed origin and UID domain plus a functions redeploy, which this drill did not do. The earlier 404 checks for missing and invalid tokens still stand. Fetch twice, UID stability, rotation and revocation remain open.

## 5. Account deletion resume

`drill-delete-20261103` had 40 synthetic `teamMembers` rows, a program staff membership in the drill organization and a `teams/drill-del-history` document it created. With an ID token issued before deletion started:

- Before deletion a callable (`listCalendarSubscriptions`) was allowed. After `beginDeletion` the same cached token was refused with `PERMISSION_DENIED` (deny-first).
- One `resumeDeletion` page then "crashed" the operator process: job `pending`, stage 0, 25 memberships removed, 1 page, 1 attempt.
- The deployed scheduled `resumeAccountDeletions` picked it up at 19:52:19Z with no operator action: `complete`, 40 memberships removed, 28 pages, 2 attempts, `lastError: null`, `residualAudit` with zero communications and attachments.
- Afterwards: Auth user `auth/user-not-found`, 0 `teamMembers` rows, organization membership and `users` profile removed, `teams/drill-del-history` kept (history survives).

## 6. Rollback

As `drill-member-20261103` (org admin) against `drill-org-20261103`:

- `applyPilotRollback` with `confirm: "yes"` was refused (`INVALID_ARGUMENT`).
- With `DISABLE_PHASE2_WRITERS` it took 1.2 s, returned `truncated: false` and quarantined `drill-stuck-pub`; a replay with the same `requestId` returned the same ids. One `pilotRollback` audit row was written.
- Flags: `scheduler`, `attendance`, `conversations` and `attachments` went from true to false; `locationAssistance`, `rsvpReminders` and the three notification flags were already false. `organizationV2`, `adminWorkspace`, `households` and `calendarSubscriptions` were unchanged.
- Stops: attachment reserve returned `FEATURE_DISABLED`, `listConversationMessages` returned `FEATURE_DISABLED`, download of the ready 10 MiB JPEG returned 404. The published events and the `ready` attachment row stayed.
- Flip back: the flags were restored to their exact pre-drill values. Conversations and downloads (200) worked again, and reserve reached the per-member `ATTACHMENT_LIMIT` (the drill had several open reservations) instead of `FEATURE_DISABLED`. The publication stayed `quarantined`, matching the runbook: re-enabling `scheduler` does not resume it.

## Cleanup

- `platformConfig/phase2Monitoring` restored to `{ enabled: true, organizationIds: ["phase2-staging-drill-20261021"] }` with its original `updatedAt`; `platformConfig/phase3Monitoring` deleted (it did not exist before); `platformConfig/attachmentScanner` still missing (built-in `content`).
- Deleted: all monitor seed rows (so no alert keeps firing), `accountDeletionJobs/drill-monitor-*`, `teams/drill-del-history`, the drill quarantine objects (4) and both Auth users.
- Kept and labeled for review: `organizations/drill-org-20261103` (writer flags and `calendarSubscriptions` now off) with its hierarchy, attachment rows and audit row; `teams/drill-team-20261103`, `events/drill-event-*`; the migrated legacy dataset (`teams/drill-legacy-team`, `users/drill-legacy-*`, `teamMembers/drill-legacy-team_*`, `events/drill-legacy-event-*`, `inviteCodes/DRLQ2345`) and its `legacyMigrationRuns` checkpoints; `accountDeletionJobs/drill-delete-20261103` (completed, counts only). Any later migration dry-run on staging will see these as already mapped v2 rows.

## Still open

- Calendar feed drill: owner sets `CALENDAR_FEED_BASE_URL` and `CALENDAR_UID_DOMAIN` for staging and redeploys functions, then rerun create, fetch twice, rotate and revoke.
- Cloud Monitoring email channel verification (owner).
- Capacity workloads remain on the owner's cost hold.
