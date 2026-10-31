# Staging operations drills, 2026-10-31

Project: team-hangout-staging only. Deployed SHA 09de28b (see PR #68). Production was not touched.

## Result summary

| Drill | Status | Evidence |
| --- | --- | --- |
| Migration rehearsal (PR #70 tool) | Blocked | No Admin credentials on the operator machine (see Blockers) |
| Phase 2 / Phase 3 monitors | Partially verified | `monitorPhase2Pilot` and `monitorPhase3Pilot` are deployed as scheduled functions; `monitorPhase2Pilot` runs every 5 minutes (log entries 19:52Z and 19:57Z) and emits no alert, consistent with `platformConfig/phase2Monitoring` not enabled. Enabling config and triggering alerts is blocked |
| 10 MiB attachment drill | Blocked | ATTACHMENT_UPLOAD_KEY exists (PR #68), but the drill needs a synthetic signed-in member and seeded org |
| Calendar feed | Partially verified | `calendarFeed` HTTPS: no token returns 404 (0.26s); invalid token returns 404 (0.29s), so unknown or revoked tokens do not leak a feed. Stable UIDs and rotation need a seeded subscription, blocked |
| Account deletion resume | Blocked | Needs synthetic Auth users and data |
| Rollback rehearsal | Blocked | Flag flips need Firestore writes to `platformConfig` |

## Blockers

- No Application Default Credentials: `GOOGLE_APPLICATION_CREDENTIALS` is unset, `~/.config/gcloud` is absent, gcloud is not installed.
- The Firebase MCP Firestore tools return "could not be found" in this session, and earlier direct Admin API calls with the CLI token were refused. So no synthetic data can be seeded and no `platformConfig` flag can be set on staging.
- Cloud Monitoring alert policies and the email channel were installed 2026-10-21 per the Phase 2 runbook; email channel verification still needs the owner.

## Procedure to finish once credentials exist

1. Export an approved staging service account key as `GOOGLE_APPLICATION_CREDENTIALS`.
2. Migration: run the staging rehearsal commands in docs/legacy-migration.md (dry-run, apply with `--max-operations 5`, resume, replay, `--reconcile`) and record counts and timings here.
3. Monitoring: set `platformConfig/phase2Monitoring` and the Phase 3 monitor config to `{ enabled: true, organizationIds: ["<synthetic-org>"] }`, seed a publication and a deletion job older than 10 minutes, three `SCAN_FAILED` rows within 15 minutes, and a `CLEANUP_RETRY_REQUIRED` row, then confirm each `Phase 2 pilot alert.` code in `firebase functions:log`.
4. Attachments: upload one 10 MiB JPEG and one 10 MiB PDF as a synthetic @example.test member, finalize and download.
5. Calendar: create, fetch twice (compare UIDs), rotate (old URL 404), revoke (404).
6. Rollback: turn the Phase 2 and Phase 3 writer flags off for the synthetic org and confirm the stop behavior listed in the runbook rollback tables.
