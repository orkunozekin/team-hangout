# Phase 2 pilot release gates and recovery

Phase 2 code is complete through P2.20. It is **not pilot-ready**. This runbook prepares a reviewable release decision. It does not authorize a deployment, a production migration, live email, push credentials, secret creation, or pilot enrollment. Do not start Phase 3 from this step.

## What the local drill proves

Use Node 22. The Firebase project is the isolated `demo-team-hangout`. Every service uses loopback. No staging project is contacted.

```sh
yarn typecheck
yarn test --runInBand
yarn test:backend
PLAYWRIGHT_CHANNEL=chrome yarn test:admin
yarn --cwd admin build
yarn test:scheduling
```

`tests/backend/pilot.test.mjs` seeds two teams and two households, then exercises the cross-tenant denials, a guardian response race, attendance, a household message, a staff note that search cannot see, the scanner kill switch, an external-scanner outage, grant expiry with and without a canonical object, and a purge that resumes from `platformConfig/attachmentPurge.objectPageToken` across object generations `/1` and `/2`. Rollback turns the phase 2 writer flags off, quarantines in-flight publications, and leaves the published event, attendance row, and message history in place. Re-enabling `features.scheduler` does not resume a quarantined publication.

Account deletion now records `residualAudit.attachments` with `ownerField: ownerUid`, the count, `anonymized: false`, and `bytesRetained: true`. It does not copy file names into the job and it does not delete objects. Message `authorUid` is also retained. That is an operator policy gate, not a completed anonymization.

The admin page `/organizations/{orgId}/pilot` shows flag state, publications stuck for at least 10 minutes, attachment state counts, rejection codes, and the scanner mode. It does not show owner ids, file names, addresses, or tokens. Each attachment state and the rejection list stop at 100 rows and say when the sample is truncated. Authorization is one small transaction. The count queries run after that so a full sample cannot exceed Firestore's 500-document transaction limit. The same org-admin grant is checked again after those queries, and a revocation during the sample returns no report. Disable phase 2 writers is an org-admin action and requires the confirmation `DISABLE_PHASE2_WRITERS`.

## Writer flags and rollback

These organization flags stop new phase 2 writes when set false. `organizationV2`, `adminWorkspace`, and `households` stay as they were so staff can still open history.

| Flag | What stops |
| --- | --- |
| `scheduler` | New schedule drafts and publication advance. A quarantined publication still refuses advance and resume. Abort remains the operator repair. |
| `attendance` | Attendance writes. Existing rows stay. |
| `locationAssistance` | Location-assisted check-in. Manual attendance is the fallback when `attendance` is still on. |
| `conversations` | New and existing channel reads, because the channel gate is the same flag. Documents stay. |
| `attachments` | Reserve, upload, finalize, and download. Bytes stay until the 24-hour quarantine purge or a later retention decision. |
| `rsvpReminders` | Reminder expansion. A sent reminder is not recalled. |
| `notificationInboxFake`, `notificationPush`, `notificationEmailFallback` | New fan-out on those channels. Inbox history stays. |

`features.attachments` stays off for organizations created by `createOrganization`. Enable it only after `ATTACHMENT_UPLOAD_KEY` exists and the scanner drill below has passed. Keep it off for the first synthetic organization if that drill is not done.

Rollback quarantines at most 20 `staging`, `promoting`, or `verifying` publications per call and returns `truncated: true` when more remain. Call it again until `truncated` is false. The in-flight publication named by `schedulingLock/current` takes a slot on every page, including when its id sorts after the first 20. The scheduling lock stays on the quarantined operation so a second publication cannot start quietly. Committed publications and their events are left alone. Idempotency receipts stay. A replay still checks the current org-admin grant, so a revoked admin cannot read the stored result.

## Secrets and scanner drills

Do this in the approved staging project only, with synthetic data. Do not put the scanner URL in Firestore.

1. Create Secret Manager `ATTACHMENT_UPLOAD_KEY` with at least 32 characters. The functions fail closed without it outside the demo emulator. The demo value `demo-attachment-upload-key-v1-do-not-use-live` is public and must not be reused.
2. Confirm `platformConfig/attachmentScanner.mode` is missing or `content` for the built-in scanner. Set `unavailable` and finalize a JPEG. The row becomes `rejected` with `SCAN_FAILED`, not `INTEGRITY` or `ACCESS_REVOKED`. Set the mode back to `content`.
3. Optional external scanner: set the mode to `external` and provide `ATTACHMENT_SCANNER_URL` as `https` only. Stop that service and finalize a clean JPEG. The file is rejected. A missing URL is the same failure. The content scanner still runs first.
4. Reserve a JPEG, wait past five minutes, and finalize with no canonical object. The result is `EXPIRED`. Repeat after a crash that left `canonicalizing` plus object `/2` whose hash matches `canonicalSha256`. That finalize becomes `ready` and the download bytes match.
5. Leave quarantine objects `/1` and `/2` older than 24 hours, including one `/2` recorded on a ready row. Run `purgeAttachmentQuarantine` twice. The saved `objectPageToken` changes, orphans disappear, and the ready `/2` stays.

The built-in scanner is not a malware appliance. Metadata that exists only inside a compressed PDF stream is not rewritten. `Crypt`, `LZWDecode`, and `RunLengthDecode` are rejected as active content. JPEG, JPX, CCITT, and JBIG2 streams stay opaque.

Finalize and download each hold the object in memory, up to 10 MiB, inside a 512 MiB function with a 60-second timeout. Staging discovery sets concurrency 1 and max instances 2. A real 10 MiB JPEG and a real 10 MiB PDF on staging are still an owner drill. This repository does not upload a 10 MiB object in the emulator suite.

## Indexes to confirm before writers

Deploy the checked-in `firestore.indexes.json` and wait until every composite index is READY. Emulator success does not prove that. The attachment and pilot indexes added for this phase are:

| Query | Index |
| --- | --- |
| Quarantine purge | Collection group `attachments`: `state ASC`, `createdAt ASC`, `__name__ ASC` |
| Deletion owner audit | Collection group field `attachments.ownerUid` |
| Stuck publications | Collection `scheduleOperations`: `state ASC`, `updatedAt ASC` |
| Rollback page | Collection `scheduleOperations`: `state ASC`, `__name__ ASC` |

The earlier phase 2 indexes in the same file, including events, deliveries, reminders, and message search, need the same READY check. The roster import bucket still falls back to `<project>.appspot.com`. Attachment bytes use the bucket from `FIREBASE_CONFIG.storageBucket` and fail closed when that name is missing.

## Acceptance checklist

| Plan item | Local result | Still external |
| --- | --- | --- |
| Security matrix: outsider, revoked staff, other-team coach, view-only guardian, self player, two guardians, removed roster, cross-organization | `tests/backend/pilot.test.mjs` plus the existing organization, conversation, availability, and rules suites | Staging rules deploy |
| Scheduling hard constraints, impossible versus budget, 31/32 teams, DST, shared coach, buffers, odd-team fairness | `tests/scheduling/scheduler.test.mjs` and `docs/scheduling-spike.md` | Production capacity. The 32-team search can exhaust its budget |
| Crash recovery for staging, commit, audience expansion, and ambiguous send | `tests/backend/schedule-publication.test.mjs` and `tests/backend/notifications.test.mjs` | Deployed task queues and real provider ambiguity |
| RSVP and attendance cases | `tests/backend/availability.test.mjs` and `tests/backend/attendance.test.mjs` | Device check-in |
| Staff notes, live attachment access, search edits | Conversation, search, and attachment emulator suites | Native channel |
| Native notification navigation and physical provider delivery | Not run here | See the QA backlog |
| Web pilot dashboard | Playwright `admin/tests/pilot.spec.ts` | Native screens are a separate pass |

## Owner ledger

Every row needs a named owner, a date, and an attached result. Empty cells mean **not accepted**.

| Gate | Required action | Status |
| --- | --- | --- |
| Staging indexes | Deploy `firestore.indexes.json` to the isolated staging project and record READY for the attachment and schedule-operation indexes above | Not done in this change |
| Upload secret | Create `ATTACHMENT_UPLOAD_KEY` of at least 32 characters. Leave `features.attachments` off until the scanner drill passes | Not created here |
| External scanner | Optional. `ATTACHMENT_SCANNER_URL` over `https` only, never stored in Firestore | Not configured |
| 10 MiB drill | One JPEG and one PDF at the cap through finalize and download on staging | Not run. Functions buffer the object |
| Retention | Decide whether `attachments.ownerUid` and message `authorUid` stay after account deletion. The audit records the residual count and leaves the bytes | Policy pending |
| Youth history | Approve who can post and what a new guardian can read | Policy pending |
| Push and email | Expo project, APNs, FCM, verified sender, bounce webhook, and physical iOS and Android receipt tests | Credentials and devices pending |
| Native QA | Work the consolidated list in `docs/phase-2-ui-qa-backlog.md` | Open |
| Monitoring | Alert on a publication or deletion job stuck over 10 minutes, repeated `SCAN_FAILED`, and `CLEANUP_RETRY_REQUIRED` | Not installed |
| Pilot partners | One synthetic organization, then consenting organizations, flags one at a time | Not approved |
| Commercial | No pricing, ads, or paid messaging | Still pending |

## Recovery

Stop rollout on a material incident. Collect organization, operation, and request ids, versions, counts, and redacted codes. Do not capture participant names, contact addresses, private notes, file names, invitation URLs, or provider raw errors.

| Signal | First response | Evidence |
| --- | --- | --- |
| Publication staging, promoting, or verifying for more than 10 minutes | Open Pilot operations. Run rollback, then repeat while `truncated` is true. Do not delete the operation or the events | Quarantined ids and the audit `pilotRollback`. Advance stays `PUBLICATION_QUARANTINED` until an operator aborts |
| `SCAN_FAILED` repeating, or the external scanner timing out | Set `platformConfig/attachmentScanner.mode` to `unavailable`, then turn `features.attachments` off | Rejected rows only. No ready file from a failed scan |
| Account deletion pending over 10 minutes or `CLEANUP_RETRY_REQUIRED` | Keep the deny marker. Call `resumeDeletion` from the service identity. Read `residualAudit.attachments` before any retention change | Job cursor, count, and the untouched objects |
| Missing index or a query error on attachments or schedule operations | Keep the new writers off. Confirm the indexes in this runbook are READY | Same query shape as the emulator test, against staging |

A service outage can show the last-known game-day cache with its stale label. Push is not an emergency alert. Already downloaded files and already sent email cannot be recalled. A tombstone hides an attachment download and does not delete the bytes.

Phase 3 is a separate instruction. This step does not implement it.
