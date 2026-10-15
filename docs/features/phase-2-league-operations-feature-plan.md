# Phase 2: Dependable league and game-day operations

Translate the [approved product direction](../plans/product-plan.md#phase-2-dependable-league-and-game-day-operations) into independently reviewable implementation steps. Read the [competitive context](../research/competitive-context.md) for anonymized motivation, not implementation proof.

## Status

| Field | Value |
| --- | --- |
| Status | in-progress |
| Last updated | 2026-10-15 |
| Implementation | P2.01 merged in PR #25. P2.02 implemented and natively validated in PR #26; GitHub Codex findings on timezone defaults, repeated reads, compatibility edits, history limits, instant ordering, plan-authorized captain management and canonical team navigation are addressed with regression tests; exact-current-head re-review and CI are required. P2.03 and later not started. |
| Prerequisite | Phase 1 foundations, access-control migration, household agenda and web administration shell |
| Commercial decision | Business model selection pending; no pricing, advertising, paid messaging, or billing enabled |
| Related PR | [P2.02 PR #26](https://github.com/orkunozekin/team-hangout/pull/26), `codex/p2-02-canonical-events`; P2.01 [#25](https://github.com/orkunozekin/team-hangout/pull/25) merged |

## Goals and boundaries

- Administrators generate feasible schedules, review conflicts, publish deliberately, and handle closures without losing history.
- Families see participant-specific availability and correct game-day details; coaches record actual attendance independently.
- Authorized adults and youth communicate through guardian-visible channels with private staff information separated.
- Push/email support the authoritative in-app state; system acceptance, provider handoff, human reading, and explicit acknowledgment remain different facts.
- Initial scheduling supports soccer, basketball, and football divisions, one organization per fixture, and individually identified fields/courts.
- No cross-organization fixtures, autonomous weather decisions, referee payroll, livestreaming, public feeds, payment collection, background location tracking, or optimal-schedule promise.
- Every numbered step below is a separate invocation and PR. Stop after its PR and review loop; implement later steps only when instructed.

## Current state and evidence

Source inspected at `d66e89b` on 2026-10-10. Planning references the current checkout; deployed production configuration was not inspected.

| Existing evidence | Consequence |
| --- | --- |
| [`src/types/models.ts`](../../src/types/models.ts): one `teamId`, split `date`/`time`, practice/match, text location, soft deletion | Add canonical instants, resource identity and lifecycle without mistaking soft deletion for cancellation. |
| [`src/firebase/events.ts`](../../src/firebase/events.ts): direct client create/update and unpaged team queries | Operational mutations move to authenticated callable services; phase-1 migration must update query adapters. |
| [`src/firebase/config.ts`](../../src/firebase/config.ts): Firebase JS SDK, AsyncStorage auth persistence, `getFirestore` and `getFunctions` | Authentication persistence is not durable Firestore persistence. Native cached game-day data needs an explicit design. |
| [`functions/src/index.ts`](../../functions/src/index.ts), [`functions/package.json`](../../functions/package.json): Node 22 callable account deletion exists | Extend the existing functions backend; account deletion must encompass new user-linked delivery/access records. |
| [`firestore.rules`](../../firestore.rules): legacy team access, including signed-in team reads and self-created coach membership | Phase-1 authorization hardening is a release prerequisite. Do not copy legacy permission shortcuts. |
| [`package.json`](../../package.json), [`app.config.ts`](../../app.config.ts): SDK54, React Navigation; no notification/location/file-picker modules | Native modules require compatible installation and rebuilt development binaries. No Expo Router migration is needed. |
| [`firestore.indexes.json`](../../firestore.indexes.json): only legacy event/membership indexes | Declare and staging-verify indexes for each new query before rollout. |

Owner soccer-app inspection was read-only at `/Users/orkunozekin/Desktop/side-projects/soccer-team-builder`, revision `944b43a` with no tracked changes at final verification. These local paths are evidence pointers, not dependencies available in another checkout:

- `lib/schedules/occurrences.ts` implements timezone-aware recurrence and stable occurrence keys; `materializeSchedule.ts` looks ahead and skips already seen keys. This supports recurrence concepts, not constrained multi-team league scheduling or concurrent uniqueness proof.
- `lib/services/rsvpService.ts` separates response and attendance fields but creates time-based IDs tied to login accounts. Replace with deterministic participant identity and transaction-backed writes.
- `lib/utils/geo.ts` contains haversine distance and coordinate validation; `app/api/check-in/route.ts` checks time, radius and accuracy server-side. Reuse formulas/tests after review, not the account-only API.
- `lib/utils/checkIn.ts` labels a confirmed response as a no-show after its window. Do not port that behavior: missing device check-in is never proof of absence.
- Executed owner-app pure tests with `node node_modules/vitest/vitest.mjs run lib/utils/geo.test.ts lib/utils/checkIn.test.ts lib/schedules/occurrences.test.ts`: 3 suites / 16 tests passed on 2026-10-10 without server/Firebase initialization. This proves existing pure recurrence/distance/window examples run; it does not prove new league scheduling, native location, authorization, or approved attendance semantics. The existing no-show inference still must be replaced.

### Official reference register

References were opened on 2026-10-10. Versioned native documentation is SDK54. Other service documentation is current and must be rechecked at implementation because service limits and SDK support can change.

| ID | Primary reference | What it supports, and what it does not prove |
| --- | --- | --- |
| R1 | [SDK54 Notifications](https://docs.expo.dev/versions/v54.0.0/sdk/notifications/) | Token, permission, foreground/response listeners and React Navigation integration; no production delivery guarantee. |
| R2 | [SDK54 Location](https://docs.expo.dev/versions/v54.0.0/sdk/location/) | Foreground permission/current-position APIs; not presence verification or spoof prevention. |
| R3 | [SDK54 BackgroundTask](https://docs.expo.dev/versions/v54.0.0/sdk/background-task/) | OS-controlled scheduling with delayed execution; iOS background tasks require physical devices. Do not use for urgent updates. |
| R4 | [Firebase JS supported environments](https://firebase.google.com/docs/web/environments-js-sdk) | React Native Firestore excludes persistence and Storage excludes uploads in the support table. Do not assume web APIs behave identically in native. |
| R5 | [Firestore transactions](https://firebase.google.com/docs/firestore/manage-data/transactions) | Atomic read/write and transaction retries; external sends cannot be made atomic with a database commit. |
| R6 | [Firestore triggers](https://firebase.google.com/docs/functions/firestore-events) | Duplicate and unordered invocation is possible; consumers require deterministic keys and revision guards. |
| R7 | [Push sending and receipts](https://docs.expo.dev/push-notifications/sending-notifications/) | Tickets, receipts, retry guidance and token errors; a successful receipt does not establish human reading. |
| R8 | [Cloud Tasks functions](https://firebase.google.com/docs/functions/task-functions) | Server-owned asynchronous tasks with controlled retries/rate limits; deployment and billing remain external gates. |
| R9 | [Secure queries](https://firebase.google.com/docs/firestore/security/rules-query) | Query constraints must satisfy rules; rules do not filter arbitrary query results. |
| R10 | [SDK54 FileSystem](https://docs.expo.dev/versions/v54.0.0/sdk/filesystem/) and [DocumentPicker](https://docs.expo.dev/versions/v54.0.0/sdk/document-picker/) | Local `File`/`expo/fetch` upload primitives and copied picker files; actual binary transport needs device validation. |
| R11 | [Storage signed URLs](https://docs.cloud.google.com/storage/docs/access-control/signed-urls) | Time-limited bearer access; possession conveys access until expiry. Not immediate revocation. |
| R12 | [Firestore text search](https://firebase.google.com/docs/firestore/enterprise/text-search) | Current full-text search documentation concerns Enterprise features; existing database edition and migration are not verified. Do not silently depend on them. |

### Feasibility matrix and proof gates

`Code-confirmed` means an existing mechanism was inspected, not proven at production scale. `Doc-supported` means official APIs exist. `Prototype-needed` means this plan explicitly requires executable evidence before shipping. `External gate` requires configuration, credentials, policy or operator action.

| Capability | Evidence level now | Required proof before release |
| --- | --- | --- |
| Canonical event reads and callable mutations | Code-confirmed baseline; R5/R9 doc-supported | Emulator test proving role isolation, revisions and both-team visibility. |
| Recurrence | Code-confirmed in owner app only | Ported pure-function tests including DST ambiguity and duplicate execution. |
| Constrained schedule generation/fairness | Prototype-needed | Seeded benchmarks, known feasible/impossible fixtures and independently checked hard constraints. |
| Draft publish/bulk closure | R5/R6/R8 doc-supported; prototype-needed | Crash injection during chunks, competing operations and repair; no family access before publication. |
| RSVP and manual attendance | Code-confirmed concept; prototype-needed | Concurrent guardians, deterministic writes, roster changes and unauthorized corrections. |
| Foreground location assistance | R2 doc-supported; prototype-needed | Native permission/accuracy tests and manual fallback; no stored raw coordinates. |
| Native last-known cache | R4 establishes limitation; prototype-needed | Restart offline with visible staleness and no data retained after sign-out. |
| Push/email | R1/R7/R8 doc-supported; external gate | Development credentials and physical-device receipt tests; verified email sender/provider and failure callbacks. |
| Searchable conversation history | Prototype-needed | Server-authorized token search scans bounded candidates across complete history; revocation and edit tests. |
| Attachments | R4/R10/R11 doc-supported limits; prototype-needed; external gate | Native upload spike, quarantining, scanner, content validation and authorized downloads. |
| Guardian-visible youth channels/private staff notes | Phase-1 relationship contract; prototype-needed; external policy gate | Emulator adversarial tests and owner-approved youth communication policy. |

Beyond the explicitly executed owner-app pure tests above, no new implementation, emulator, physical-device delivery, scanner, production index, deployment, or scheduling throughput has been proved by writing this plan. A failed proof gate narrows the pilot or blocks the affected capability; it must not be reported as completed.

## Phase 1 contract and cross-phase interfaces

Before step 1, verify the following contract against the merged phase-1 plan and implementation:

- `/organizations/{orgId}/members/{uid}` stores active scoped staff roles and `programIds`; platform support access is not ordinary organization membership.
- `/organizations/{orgId}/participants/{participantId}` uses random participant IDs, not auth UIDs, and an optional `linkedUserId` for self access.
- `/organizations/{orgId}/participants/{participantId}/guardians/{uid}` stores active/revoked relationship and `viewSchedule`, `respond`, `viewProfile`, `editProfile` permissions. Use active state at action time.
- `/teams/{teamId}/roster/{participantId}` stores `orgId`, participant identity, active/removed status and history. `/teamMembers/{memberId}` remains authenticated coach/captain access.
- `/users/{uid}/participantLinks/{orgId_participantId}` is a self-only server-maintained pointer, not a staff-readable household directory.
- Teams/events stay top-level with immutable `orgId`; scoped hierarchy IDs are checked against canonical organization documents.
- Canonical events use `schemaVersion:2`, UTC `startsAt`/`endsAt`, IANA `timeZone`, and `teamIds`. Keep non-null `teamId = teamIds[0]` as the primary legacy team during compatibility, and require at least one team ID. A match has one canonical event shared by both teams.
- Phase-1 agenda and calendar feed adapters must consume this event contract, respect published visibility and revisions, and retain stable event UIDs after rescheduling.
- Phase 1 permits a null `publicationOperationId` for server-owned single-event publication and legacy migration. Preserve that compatibility only for those records, or backfill committed markers before removing it. Every Phase 2 staged bulk publication requires a non-null marker; clients cannot clear it or choose the compatibility path.
- Phase 3 consumes canonical `eventId`, explicit home/away team IDs, attendance snapshots and effective resource occupancy. Do not create one competing score-bearing event per team.

Migration defaults are not guessed: ambiguous legacy timezone/end duration/resource association enters a staff correction queue. Preserve the original `date`/`time` during cutover; stop writing them only after an explicit client compatibility decision.

## Design

### Data model

All following additions are proposed, not existing. Every server-written document has `schemaVersion`, server timestamps and an audit correlation ID. `revision` is monotonic for mutable entities. Subcollection paths inherit their parent organization/event identity but still validate references.

| Proposed path/entity | Minimum fields and invariant |
| --- | --- |
| `organizations/{orgId}/facilities/{facilityId}` | Name, address, timezone, optional coordinates, parking/accessibility instructions, active state. No unrelated participant contact data. |
| `.../facilities/{facilityId}/resources/{resourceId}` | Field/court label, compatible sports, effective-dated immutable availability revisions, setup/cleanup minutes, active state. Shared physical spaces need one resource identity; preserve historical availability and closure intervals for phase-3 utilization denominators. |
| `.../closures/{closureId}` | Resource IDs, interval `[startsAt,endsAt)`, reason, revision, operation ID, applied state. Whole-facility closure resolves to all active resources. |
| `.../scheduleDrafts/{draftId}` | Season/division, input revision/hash, deterministic seed, constraints, state, unscheduled fixture IDs and diagnostics; staff-only. |
| `.../scheduleDrafts/{draftId}/fixtures/{fixtureId}` | Team pair, candidate assignment, explanation, hard conflicts and fairness metrics; no household access. |
| `.../scheduleOperations/{operationId}` | Action, actor, idempotency key, input hash, lease, cursor, state, counts, error summary, retry deadline. |
| `.../schedulingLock/current` | Fenced lease token and expiry for organization-level schedule mutations; small pilot favors correctness over concurrent publication. |
| `.../scheduleSeries/{seriesId}` | Team, local weekday/time, timezone, duration, date bounds, active flag, exclusions and revision. Expand explicitly into a finite reviewed draft. |
| `events/{eventId}` additions | `orgId`, scope IDs, `teamIds`, `homeTeamId`, `awayTeamId`, timestamps, `facilityId`, `resourceId`, location snapshot, arrival offset, uniform, public instructions, revision. |
| Event lifecycle | `status:scheduled|postponed|cancelled|completed`, `scheduleVersion`, optional original interval, `rescheduledFromRevision`, postponement reason and `completedAt`. Lifecycle is independent of soft deletion. |
| Event publication | `publicationState:staged|published`, `publicationOperationId`; staged events are never family-visible or notified. |
| `events/{eventId}/availability/{participantId}` | `status:yes|no|maybe`, optional late-arrival text capped at 240 characters, actor UID, revision, timestamp. Missing means unanswered. |
| `events/{eventId}/attendance/{participantId}` | `status:unknown|present|late|absent|excused`, recordedBy, source `coach|self|guardian|geoAssisted`, server timestamp, correction reason/revision. |
| `events/{eventId}/rosterSnapshots/{participantId}` | Participant and team IDs, eligible status, captured revision, active/removed dates; freezes reporting denominator on completion. |
| `.../conversations/{conversationId}` | Scope organization/division/team/event, scope ID, youth/adult mode, sequence, pinned message IDs, revision. Staff notes use separate staff-only paths. |
| `.../conversations/{conversationId}/messages/{messageId}` | Author UID, server-assigned sequence, text ≤4,000 chars, attachment IDs ≤3, createdAt, editedAt, tombstone, revision and idempotency key. |
| `.../conversations/{conversationId}/messages/{messageId}/reactions/{uid_emoji}` | Actor UID and one allowlisted emoji; deterministic identity, reversible action. |
| `.../messageSearch/{messageId}` | Conversation ID, normalized unique tokens, message revision; server-only read/write, no private note text. |
| `.../attachments/{attachmentId}` | Conversation, owner, object generation, content type/size/hash, state `pending|quarantined|ready|rejected`, scan result and expiry. |
| `.../outbox/{intentId}` | Source type/ID/revision, audience scope, template key, critical flag, operation ID, expansion cursor and state. No client writes. |
| `users/{uid}/notifications/{notificationId}` | Self-only safe summary, canonical target, source revision, `readAt`, `acknowledgedAt`; live authorization checked before showing content. |
| `.../deliveries/{deliveryId}` | Recipient UID/channel, intent ID, status, attempts, provider ticket/receipt IDs, next attempt and error code; staff delivery diagnostics redact token/email. |
| `users/{uid}/pushDevices/{installationId}` | Token, platform, project ID, permission state, lastSeen, revokedAt; self or server access only. |

Use deterministic IDs for intent (`eventId:revision:changeKind`), per-user notification (`intentId:uid`), channel delivery (`intentId:uid:channel:installationId`), recurring fixture (`seriesId:localDate:slotId`) and availability/attendance (`participantId`). Hash components if necessary to avoid path separators. Never use timestamps as uniqueness protection.

### Service APIs and authorization

Extend existing callable functions rather than placing privileged rules in screens. Caller identity comes only from verified auth, never an input UID. Every mutating request includes `requestId`; revisioned mutations include `expectedRevision`. Store request ID plus payload hash and committed result; replay returns that result, changed payload with same ID fails.

| Proposed callable | Contract and server checks |
| --- | --- |
| `generateScheduleDraft` | `{orgId,divisionId,constraints,seed,requestId}` → operation/draft ID. Staff scope, input bounds and reference ownership verified before enqueue. |
| `validateScheduleDraft` | `{orgId,draftId,expectedRevision}` → hard conflicts, unscheduled fixtures, fairness summary. Re-read current constraints, not cached client flags. |
| `publishScheduleDraft` | `{orgId,draftId,expectedRevision,requestId}` → resumable operation. Require zero hard conflicts and no unscheduled required fixtures; alternatives stay drafts. |
| `mutateEventSchedule` | `{eventId,expectedRevision,action,patch,requestId}`. Action is edit/postpone/cancel/reschedule/complete; validate role, state and occupancy. |
| `previewFacilityClosure` / `applyFacilityClosure` | Scoped interval/resources → preview with event revisions; apply validates preview hash and returns operation. Stale previews require another review. |
| `setAvailability` | `{eventId,participantId,status,lateNote,expectedRevision,requestId}`. Active eligible participant, self or guardian `respond`; coach proxy is explicit audited action. |
| `recordAttendance` | `{eventId,participantId,status,reason,expectedRevision,requestId}`. Assigned coach/staff may record/correct; participant/guardian may only check in, never assert absence for others. |
| `checkInParticipant` | Event/participant, method, transient location sample, request ID. Server time/window, roster, current access, venue and accuracy validation. No confirmed RSVP prerequisite. |
| `sendMessage` / `editMessage` / `reactToMessage` | Conversation, body/attachments, expected revision and request ID. Current audience access; only author edits own text, scoped moderator can tombstone with reason. |
| `searchMessages` | Scope/conversation, normalized query and signed cursor → ≤50 authorized results. Never expose index documents directly. |
| `createAttachmentUpload` / `finalizeAttachment` | Conversation, name/type/bytes → short-lived upload URL; finalize verifies object metadata/scan and generation. |
| `downloadAttachment` | Attachment ID → authenticated streamed content after live access check. Do not persist public download-token URLs. |
| `markRead` / `acknowledgeCriticalUpdate` | Notification ID and source revision. Only caller state changes; acknowledging old revision cannot acknowledge a newer closure. |

Callable functions run with Admin SDK and bypass Firestore rules: duplicate all scope/access validation in shared server helpers. UI disabling is not authorization. Return structured domain codes (`STALE_REVISION`, `ACCESS_REVOKED`, `OUTSIDE_WINDOW`, `SCHEDULE_CONFLICT`, `RATE_LIMITED`) in `details.domainCode` under the supported callable transport error envelope defined in Phase 1, without leaking existence across organizations. Never pass custom domain strings as Firebase `HttpsError` transport codes.

### Schedule algorithm and publication

1. Normalize finite input into teams, required pairings, resources, UTC candidate intervals and actor-conflict groups. Limit pilot input to 32 teams/division, 16 weeks and 1,000 candidate slots; reject bigger input with an actionable limit explanation, not truncation.
2. Generate round-robin pairings with rotating byes for odd team counts; repetitions are explicit division settings. Distinguish fixture generation from slot assignment.
3. Enforce hard constraints: resource compatibility/availability/closure, team overlap, assigned coach overlap, blackouts, minimum rest, division duration, season bounds and setup/cleanup occupancy.
4. Detect coach conflict through authorized staff assignments. Cross-organization coaching conflicts require a coach-approved busy-interval mechanism; otherwise clearly disclose that cross-organization conflicts are not checked. Never reveal another organization's event details.
5. Assign most-constrained fixtures first; deterministic seeded ordering and bounded backtracking stop at 100,000 search nodes or 10 seconds of algorithm time, whichever first. Record partial assignments and diagnostic conflicts; no false claim of impossibility when search budget expires.
6. Optimize soft metrics lexicographically: fewest unassigned fixtures, lowest maximum home/away imbalance, lowest late-slot imbalance, then total preference penalty. Hard constraints are never relaxed to improve fairness.
7. Independent validator checks result from scratch. Show home/away counts, byes, rest, early/late distribution and unmet preferences. Staff can edit a draft and revalidate; nonzero hard conflicts block publication.
8. Acquire fenced organization scheduling lease; revalidate resource/team/coach occupancy against current published events and current closure revisions. All schedule-mutating APIs honor the same lease.
9. Stage finite chunks ≤100 event writes with `publicationState:staged`, recording progress. Use deterministic event IDs; every event points at its non-null publication operation. Then make a second resumable pass that changes every staged event to `publicationState:published` in bounded chunks while the operation remains uncommitted. Persist separate staging and promotion cursors/counts, and retain immutable expected event IDs/revisions so retries cannot promote unrelated or changed events. Readers require both published event and committed operation marker, so even partially promoted chunks remain invisible.
10. Finalize only after checking the complete expected event set has the correct operation ID, payload/revision and `publicationState:published`, all staging/promotion chunks are confirmed, and input revision/lease fencing still matches. A cursor count alone is insufficient. Atomically mark the operation committed and write the outbox intent; that marker makes the complete canonical event set eligible for agenda/feed reads. Workers then expose projections and notify from that committed revision. A crash before marker commit leaves every newly staged/promoted event hidden; resume the recorded passes and verification before committing.
11. If worker dies, operation remains staged and resumable; repair job uses recorded cursor and deterministic keys. Reject expired fencing token. Cleanup aborted staging only after readers cannot reference it.
12. Readers may momentarily receive projections in separate batches, but they must not show mixed draft content as fully synchronized. Display revision/loading state and refetch canonical data before actions.

Existing published event mutations use a bounded transaction per event plus audit/outbox writes. Large closure operations commit individual event updates with visible progress, not a falsely promised atomic 500-event update. Closure interval becomes authoritative immediately; API reads and attendance actions reject events whose effective resource interval is closed even before downstream materialization completes. Worker failure alerts staff and can be resumed.

Recurring practices are materialized for an explicitly reviewed season range using local calendar dates, not 24-hour millisecond increments. Reject nonexistent local DST times; require selection of an offset for ambiguous times. Store chosen UTC instant and timezone. Rescheduling retains event identity and original revision; postponement removes active occupancy, disables attendance and preserves all history. Default reschedule behavior preserves previous RSVP as historical and marks it `needsReconfirmation` for the new schedule version; do not count it as current yes/no until reconfirmed.

### RSVP, check-in and offline behavior

- Render availability for each household participant, with name/team and actor context. Shared-event aggregate groups by team and counts unique participants.
- Separate unanswered, maybe, yes and no. RSVP deadline defaults to event start; staff can set earlier. Close/edit policy is server-enforced and visible.
- Coaches record attendance even when response was no/unanswered; no attendance row means unknown. Completing an event does not auto-convert unknown into absent.
- Manual attendance works without participant devices. Guardian/simple self check-in records an assertion and source; staff can correct with a reason.
- Foreground location is optional per organization/event. Request permission only at check-in, use SDK54 `requestForegroundPermissionsAsync` and `getCurrentPositionAsync`, and offer manual help on denial/timeout.
- Initial assistance defaults: window from 40 minutes before start to 2 hours after start; radius 500 m; required sample accuracy ≤100 m; sample age ≤60 seconds. Label these pilot defaults, make window/radius staff-configurable within server bounds, and never treat them as identity/presence proof.
- Validate latitude/longitude finite/range and accuracy finite/positive. Use server clock, not device time. Poor accuracy/missing venue/closed event returns a specific fallback message. Discard raw sample after computation; audit only outcome and method.
- Keep safe agenda/event last-known snapshots explicitly in AsyncStorage under account/org/schema keys; exclude messages, attachments, private notes, guardian contacts and raw location. Limit cached window to previous 7/next 30 days with 24-hour refresh TTL.
- Cache is read-only and visibly stale offline; queued edits are not silently accepted. A write times out to unknown-result state and retries using the same request ID after server reconciliation.
- Clear cache on sign-out/account switch/deletion and access revocation on next online contact. Previously downloaded information cannot be remotely erased offline; disclose this limitation and avoid sensitive fields in cached snapshots.
- Do not add periodic background tasks to solve urgent synchronization. Refresh on foreground/network return; OS scheduling cannot meet closure notification deadlines.

### Communication, search and attachments

- Organization/division announcements are staff authored; team/event conversation participation is restricted to current authorized audience. Pinning is scoped staff/coach only.
- Youth communication defaults to group channels visible to all currently authorized guardians and assigned staff. Do not implement private adult-to-minor direct messages. Youth channels require an approved organization policy before enabling youth posting.
- Separate staff-only notes and staff conversations from all family projections, message search, push/email bodies and attachments. A note must never be made private solely by a hidden UI control.
- A guardianship revocation removes future channel access; grants follow explicit history policy. Default new guardians see current season group history, never another household's private records. Changing this policy is a material privacy decision needing owner review.
- Use server-assigned monotonic sequence and pagination; append immutable edit audit without making old text publicly readable. Tombstones preserve sequence; search follows current text and deletes old tokens.
- Search v1 is exact normalized word-token matching within an authorized conversation, optionally limited to a date range; not fuzzy/semantic search. Minimum 2-character tokens, at most 5 query terms, ≤200 unique indexed tokens per message.
- Server uses `array-contains` for first token, reads bounded batches of 200 candidate hits, intersects remaining terms and returns cursor even if a page has fewer results. Cap each request at 1,000 candidates and return `partial:true` plus continuation; no silent claim to have searched all history.
- Do not download entire message history to a mobile device for search. For each candidate, recheck current conversation permission and canonical message revision; private search index is server-only. Full-text engine is a later explicitly chosen integration if token search fails pilot needs.
- Limit attachments initially to JPEG/PNG/PDF, ≤10 MiB each and ≤3/message. Validate extension, content signature and actual object bytes; do not trust client MIME. Reject executable/HTML/SVG content.
- Use `expo-document-picker` with `copyToCacheDirectory:true`, SDK54 FileSystem `File` plus `expo/fetch` to upload to a short-lived server-issued signed URL. Do not rely on unsupported Firebase JS Storage native uploads.
- Upload authorization binds conversation, owner, object path/generation, size and expiry; quarantine objects are never downloadable. Finalization verifies actual bytes, strips image metadata via server transform, and scans before `ready`.
- Scanner infrastructure and runtime limits are an external gate. If unavailable, attachments stay disabled while text launches; phase 2 is not marked fully complete until the approved attachment capability is proven.
- Serve downloads through authenticated authorization on each request; signed uploads remain bearer capabilities until expiry, so use 5-minute expiry and isolated quarantine paths. Already downloaded files cannot be revoked.
- Purge abandoned quarantine files after 24 hours. Account deletion anonymizes message author labels where retention is required and removes tokens/user cache links; final retention duration needs operator policy before pilot, with deletion request handling documented.

### Notification pipeline and delivery semantics

- Transaction commits canonical mutation and deterministic outbox intent together. A trigger enqueues bounded task workers; never send inside a transaction callback.
- Expand audience from current scope/rosters and active guardian/self/staff relationships; deduplicate UID across children/roles and installations across devices. Verify recipient still authorized at send time.
- Phase-1 email fallback adapter is reused if available. Verified sender, bounce/webhook authentication and provider credentials are required before email pilot; retain provider neutrality in product packaging.
- Scheduler-generated reminder is server-owned, not a phone timer. Default one reminder 24 hours before RSVP deadline, only to unanswered/needs-reconfirmation participants; if created later, send at most one immediate reminder with ≥1 hour remaining.
- Critical closure/reschedule intents bypass ordinary digest scheduling. Respect communication preferences except explicitly opted-in operational safety delivery; do not create promotional consent by inference.
- Device registration uses `getExpoPushTokenAsync({projectId})`, Android channel setup before permission request, token-change handling and logout revocation. Rebuild native binaries for plugins/entitlements.
- Set a generic lock-screen body for youth/group messages; fetch sensitive details after authentication. Deep-link payload uses allowlisted internal target type/ID, not arbitrary URLs.
- Handle foreground notification and response listeners plus last response on cold start. Preserve target through sign-in; revalidate live permissions and gracefully show unavailable content after removal.
- Delivery statuses: queued, sending, providerAccepted, providerReceiptOk, retryableFailure, permanentFailure, unknownOutcome. Never label these as read. Human `readAt` requires opened in-app content; critical `acknowledgedAt` requires explicit action at source revision.
- On transient errors retry with exponential backoff/jitter capped at 5 attempts/24 hours; follow provider retry headers. Disable invalid tokens on permanent device-not-registered response. Redact raw tokens and email in logs.
- Lease and deterministic delivery IDs prevent duplicate database work, but external push/email has an unavoidable crash window after provider send before status persistence. On ambiguous sends record unknownOutcome and avoid immediate blind resend; use provider idempotency if available and deduplicate visible inbox by intent ID. Do not promise exactly-once device notifications.
- Poll push receipts via bounded server tasks; receipts are provider handoff evidence, not device visibility. Staff dashboard shows failed/unknown channels and unacknowledged critical changes separately.
- Badge count derives from authoritative per-user unread state, not increments on every push callback. Out-of-order workers compare source revision and cannot overwrite newer projections.

### Query, index and rules strategy

Proposed indexes must match actual implemented query shapes; deploy and test in staging because emulators alone do not establish production index readiness.

| Query | Proposed composite index / pagination |
| --- | --- |
| Published team agenda | events: `orgId ASC, teamIds ARRAY_CONTAINS, publicationState ASC, startsAt ASC`; time cursor + document ID tie-break. |
| Resource occupancy interval | events: `orgId ASC, resourceId ASC, publicationState ASC, startsAt ASC`; query bounded season/day start range and filter overlapping end server-side. |
| Closure affected events | Same resource index; include events starting before closure by bounded max duration/lookback, not startsAt-only overlap logic. |
| Staff draft operations | org subcollection: `state ASC, createdAt DESC`; limit 50. |
| Conversation messages | messages: `sequence ASC`; limit 50 and cursor. No unrestricted collection-group client reads. |
| Search candidates | messageSearch: `conversationId ASC, tokens ARRAY_CONTAINS, createdAt DESC`; limit 200/cursor. |
| Delivery worker queue | deliveries: `status ASC, nextAttemptAt ASC`; limit 100/lease. |
| Personal unread inbox | notifications: `readAt ASC, createdAt DESC`; limit 50. |

Availability and attendance fetch direct participant documents for households and bounded roster-sized lists for coaches; never let families list all records to filter locally. Staff dashboards paginate organizations/programs explicitly. Avoid unbounded UID/team-ID arrays and relying on oversized `in` queries.

Server-maintained agenda is self-only and must be live-access safe. Use the phase-1 `listHouseholdAgenda` authenticated callable aggregate with live grant filtering; direct agenda projection reads remain denied. Do not replace it with a client Firestore list whose per-document live relationship checks exceed rule access limits. If phase 1 uses projections, contain only safe event summaries plus bounded `teamIds`/access version, and prove list authorization under actual rule limits before retaining direct reads.

Deny client writes to scheduling operations, canonical schedule fields, occupancy records, notification outbox/deliveries, message search and attachment readiness. Client event reads require current organization/team/participant grant and published state; a non-null publication operation must be committed. The server-owned Phase 1 null-marker compatibility above cannot be used for staged bulk events. Changing immutable ownership fields is always denied. Audit records are append-only server-written, scoped staff readable, and redact message/location payloads.

## Numbered implementation steps

Each checkbox is a bounded PR, with its own migration/rollback and acceptance evidence. Proposed module names below are not claims that these files exist.

1. [x] **P2.01 Establish operational contracts and tests.** Extend types/adapters and add shared server authorization, revision/idempotency helpers. Add emulator test scripts/config and fixtures, preserving account deletion tests. Exit: stale writes, spoofed IDs and cross-org access rejected; legacy event readers have explicit compatibility coverage. No UI effect.
2. [ ] **P2.02 Canonical multi-team event service.** Implemented in [PR #26](https://github.com/orkunozekin/team-hangout/pull/26); GitHub Codex review pending, not merged. Add callable event mutation/lifecycle and publication visibility rules; adapt existing native event screens. Exit: one match appears for both teams; cancel/postpone/reschedule/history differ; screenshots show each changed state and stale-save error.
3. [ ] **P2.03 Facility/resource availability.** Add staff forms, scoped server CRUD and occupancy interval validator. Exit: exact field/court labels, buffers and overlap boundaries tested; screenshots show unavailable resource and accessible map/details. Do not create recurrence yet.
4. [ ] **P2.04 Recurrence materialization.** Add pure timezone recurrence generator, finite reviewed series draft and stable occurrence IDs. Exit: DST, exclusions, retries and series revision tests; screenshots show preview and ambiguous-time correction. Do not auto-publish.
5. [ ] **P2.05 Scheduling feasibility spike.** Implement only pure pairing/assignment/independent validation module and seeded benchmark harness. Exit: known-feasible and impossible examples, odd teams, conflicting coaches and budget exhaustion produce truthful results; record runtime/input-size results in PR. No claim of global optimality.
6. [ ] **P2.06 Schedule draft administration.** Add web draft editor, constraints, fairness diagnostics and conflict review using proven module. Exit: manual edits invalidate old validation; impossible results remain drafts; screenshots show complete and partial schedules. Publishing remains disabled.
7. [ ] **P2.07 Resumable publication.** Add scheduling fence, staged chunks, explicit staged-to-published promotion pass, commit marker, outbox intent and projection integration. Exit: use a 201-event fixture spanning at least three chunks; crash during staging, during promotion, and immediately before marker commit. Agenda/feed/direct-read authorization must expose none of the new batch before commit; after resume and commit, every expected event is published and available exactly once in its authorized team/household views. Also test no draft leakage, duplicate event, stale lease publication or pre-commit notification. Screenshots show progress and recovery.
8. [ ] **P2.08 Closure and makeup operations.** Implement impact preview/apply, immediate effective closure, resumable event updates and reviewed makeups. Exit: overlap spanning midnight/closure boundary, concurrent staff edit and failed chunk recovery tested; screenshots show affected teams, postponed state and makeup preview.
9. [ ] **P2.09 Participant availability.** Implement deterministic participant RSVP, guardian edits, late note and reconfirmation after reschedule. Exit: concurrent guardian updates and removed roster access tested; screenshots show two children, unanswered/maybe and reconfirmation states.
10. [ ] **P2.10 Attendance and roster snapshots.** Add coach manual attendance/corrections and completion snapshots; no automatic absences. Exit: no-device, absent RSVP and canceled-event scenarios; screenshots show intended versus actual attendance and correction audit. Reporting interface supplied to phase 3.
11. [ ] **P2.11 Native check-in assistance.** Install/rebuild SDK54 location and implement foreground/simple check-in against existing attendance API. Exit: permission denial, stale/poor sample, closed event and spoofable-assistance labeling; native screenshots and device test results. No background location.
12. [ ] **P2.12 Game-day read-only cache.** Implement safe snapshot persistence and foreground refresh/reconciliation. Exit: force restart offline, stale banner, sign-out cleanup and unknown write result tested; native screenshots identify staleness. No offline mutation queue.
13. [ ] **P2.13 Notification inbox/outbox worker.** Build deterministic intent expansion, retry/lease state machine and in-app unread/read/ack actions using fake provider adapter. Exit: duplicate unordered tasks, revoke-before-send and ambiguous provider result tests. Screenshots distinguish unread/acknowledged/failed.
14. [ ] **P2.14 Push/email adapters and deep links.** Integrate actual delivery behind flags, SDK54 plugin setup, token lifecycle, receipt polling, email fallback and cold-start navigation. Exit: provider sandbox plus physical iOS/Android tests, denied permissions and access-after-login; PR reports exact credential blockers and never equates simulator payload injection with provider delivery.
15. [ ] **P2.15 Server RSVP reminders and staff diagnostics.** Add due reminder task/cron, deduplicated nonresponder recipient calculation and operational dashboard. Exit: moved deadline, rescheduled event, bounced email, expired token and repeated scheduler run tests; screenshots show failure and non-acknowledgment separately.
16. [ ] **P2.16 Scoped announcements and conversations.** Add guardian-visible text channels, pinning, staff-only notes and moderation with policy gate. Exit: revoked guardian, youth channel, staff-note leakage and member removal tests; native/web screenshots show appropriate audience and denied actions.
17. [ ] **P2.17 Corrections, reactions and searchable history.** Implement sequence pagination, text edits/tombstones, server token index/search and reactions. Exit: old text disappears from search, revoked audience sees no results, >1,000 candidates returns truthful continuation; screenshots show search and edited/deleted messages.
18. [ ] **P2.18 Attachment transport spike.** Implement isolated development upload/download path with native SDK54 File/`expo/fetch`, short expiry and fake scanner interface. Exit: both native platforms transfer chosen JPEG/PDF and reject oversized/expired uploads; no feature flag enabled until proof recorded. Capture native picker/result evidence.
19. [ ] **P2.19 Quarantined production attachments.** Add real scanner/metadata stripping, authorized streaming, lifecycle cleanup and message linking. Exit: unauthorized download, revoked membership, wrong signature, scanner failure and orphan cleanup tests; screenshots show scanning/rejected/ready states. Unavailable scanner blocks this step.
20. [ ] **P2.20 Integrated pilot hardening and runbooks.** Add end-to-end seeded multi-team/household scenario, staging indexes, load/concurrency checks, access/deletion audits, dashboards and rollback drills. Exit: complete acceptance checklist below with remaining external blockers stated; no automatic next-phase implementation.

## Files to touch

Existing paths are linked; all others are explicitly proposed. Organize server logic by domain rather than expanding one giant handler file.

| Area | Existing/proposed changes |
| --- | --- |
| Contracts/adapters | Existing [`src/types/models.ts`](../../src/types/models.ts), [`src/firebase/events.ts`](../../src/firebase/events.ts), [`src/firebase/config.ts`](../../src/firebase/config.ts); proposed `src/api/operations.ts` and `src/lib/gameDayCache.ts`. |
| Native UI | Existing [`src/screens/ScheduleScreen.tsx`](../../src/screens/ScheduleScreen.tsx), [`src/screens/EventDetailScreen.tsx`](../../src/screens/EventDetailScreen.tsx), [`src/screens/CreateEditEventScreen.tsx`](../../src/screens/CreateEditEventScreen.tsx); proposed attendance, inbox and conversation screens. |
| Backend | Existing [`functions/src/index.ts`](../../functions/src/index.ts); proposed `functions/src/operations/`, `scheduling/`, `attendance/`, `communications/`, `notifications/`, and matching tests. |
| Security/deployment | Existing [`firestore.rules`](../../firestore.rules), [`firestore.indexes.json`](../../firestore.indexes.json), [`firebase.json`](../../firebase.json), [`app.config.ts`](../../app.config.ts); proposed storage rules and emulator integration test directory. |
| Web administration | Use phase-1 Vite React/TypeScript web administration workspace, separate from native auth imports; proposed schedule draft, closure and delivery views under its route structure. Do not add a second web app. |

## Validation, rollout and acceptance

Tests below are future required work, separate from the explicitly recorded 3-suite owner-app pure test run. Run existing `npm run typecheck`, `npm test -- --runInBand` and functions build as applicable; add emulator integration and algorithm benchmark commands in P2.01/P2.05. Run no production database writes or participant-data copies to validate the plan.

- [ ] Security emulator tests include outsider, revoked staff, coach of other team, guardian with view-only permission, self player, two guardians, removed roster and cross-organization forged references.
- [ ] Scheduling tests verify every hard constraint independently, impossible/budget-exhausted distinctions, 31/32-team boundaries, DST transitions, shared coach, resource buffers and odd-team fairness.
- [ ] Crash tests interrupt staging, commit, audience expansion and send acknowledgment; recovery is resumable and truthful about external-send ambiguity.
- [ ] RSVP/attendance tests cover unknown attendance after event end, no device, no RSVP, guardian race, withdrawn participant, cancellation and reschedule reconfirmation.
- [ ] Communication tests prove staff notes never reach household history/search/push/email, attachment access is checked live, and old content does not survive edits in search.
- [ ] Native verification covers foreground/background/cold-start notification navigation, denied permission, deep link after login and invalid target. Physical-device provider tests are separate from simulated notification tests.
- [ ] UI screenshots cover affected native and web states with non-sensitive seeded data, enlarged text, screen-reader labels and loading/empty/error cases. Confirm the running app matches PR checkout and latest UI commit; inspect and recapture after changes.
- [ ] PR embeds reviewer-accessible screenshots under **UI evidence**. Local paths alone are insufficient; if execution/upload is blocked keep PR draft and state exact limitation. Documentation-only PR states UI evidence not applicable.
- [ ] Each implementation PR follows repository AI feedback loop, uses `address-pr-feedback`, fixes valid feedback, posts a new bot-tagged re-review comment after fixes, and waits within bounded intervals. Do not merge automatically.

Roll out per organization using independent server flags for event-v2 writes, scheduler, attendance, location assistance, notifications, youth channels and attachments. Server authorization enforces flags; client flags only hide controls. Deploy indexes and compatible readers before writers, then emulator/staging validation, then one synthetic organization, then consenting pilot organizations.

Initial engineering budgets to verify, not proven performance claims: 32 teams/division, 1,000 slots/run, 100 writes/chunk, 50 messages/page, 10 MiB/file, and 5 delivery retries/24 hours. Record stage runtimes, task backlog, publication failures, notification permanent/unknown outcomes, projection lag and attachment rejection rate without personal data. Alert operator on stuck operation >10 minutes or repeated hard failure; operator owns repair, not an unattended phone background task.

Rollback disables new writers/workers and keeps compatible read/history paths; do not delete schedule/attendance/message audit history. Quarantine in-flight publication, stop reminder sends for canceled operations, and preserve idempotency records during repair. A service outage offers last-known safe agenda with stale labeling plus staff communication runbook; push is not an emergency-alert substitute.

Before pilot the owner must approve youth posting/history policy, data retention/deletion procedure, operator responsibility, sender credentials and real native push testing. These are external release gates, not reasons to invent policy during coding. Business model and prices remain pending and must not be encoded as feature restrictions.

## Handoff

> Updated by `/handoff`; `/feature-context` reads this before implementation.

### Done so far

- P2.02 started from fetched remote `main` at `db2ca81a072ff1fb5b9d3c9f9ffee18a9f6c4420`, the verified squash of P2.01 PR #25. GitHub confirms final reviewed head `a9fc21ddc5967c7213f5c6e52a29a5b403e08fff`, explicit Greptile 5/5 and all three CI jobs passing. Initial P2.01 foundation baseline was PR #24 at `eec291f452374743701eb6fed25a0bb8fe629a8e`. Open PR #23 staging acceptance was not adopted or modified.
- Existing canonical event commands, staff/program/coach scopes, participant/guardian and roster boundaries, household agenda/calendar, email and deletion interfaces inspected. Phase 1 deliberately rejects `respond: true` guardian grants; P2.09 must enable response policy explicitly. Agenda/feed currently accept published null-marker events and reject non-null operation markers; P2.07 must add committed-marker reads. ICS uses stable event ID UIDs and event revisions. The source inventory above is historical; direct client event writes were already replaced in Phase 1.
- P2.01 adds operational JSON/native reader contracts, reusable server access/revision/receipt helpers, malformed-grant and identity defenses, and explicit legacy reader compatibility tests. Existing receipt hashes/storage and deletion coverage are preserved. No new user-linked storage, UI behavior, lifecycle command, deployment or production access.
- Local Node 22 validation passed: native typecheck, 25 unit suites / 132 tests with coverage, Functions build, 7 pure contracts, 3 helper tests, the full isolated backend suite (132 tests including deletion), and the focused operations gate (39 tests including deletion).
- Focused `yarn test:operations` reuses isolated emulator configuration and includes deletion tests; full backend CI retains all suites. See `docs/backend-testing.md` for contracts and boundary details.

- P2.02 implements `functions/src/operations/events.ts`: bounded callable native team/event/opponent reads with live staff/coach/household access, every-team mutation authority, published null-marker visibility, and revisioned edit/postpone/cancel/reschedule/complete with immutable safe schedule history. Stable event identity, original interval, schedule version and reschedule revision survive changes; completion does not infer attendance. No new user-linked storage is added; existing receipt deletion coverage remains active.
- Native existing schedule/detail/form adapters now show canonical events in both teams, use authorized opponent choices, display local date/time/duration and timezone, reject DST gaps and require explicit repeated-hour selection. Stale saves preserve edits, show server conflict guidance and offer explicit reload. Legacy split date/time and soft-deletion behavior remain separate.
- P2.02 validation: Node 22 native typecheck, Functions build, 27 unit/component suites / 144 tests with coverage thresholds intact, and 136 backend tests including deletion. The full isolated run passed 135/136; its remaining rehearsal failure came from the temporary harness's Git context/local server permission and passed in a focused 3/3 guard rerun. Auth/Firestore/Functions/Storage ports were 9299/8280/5201/9399 because another project's emulators owned the defaults. Production indexes and deployment were not tested.
- Eleven actual iPhone 17 Pro / iOS 26.5 captures are inspected and attached with captions in PR #26 **UI evidence**: empty filter, opponent picker, both team schedules, scheduled/postponed/rescheduled/cancelled/completed states, local reschedule form and a real stale-save failure. Source `a56a17e4ad50a214d679b6f715565b642fd86449`; the form image is from `bcea905dc9b2fffc5421da6316b81740a18a214b` with identical form source at `a56a17e`. Metro ran from this checkout on 8082 against the synthetic demo emulators. Shared match `mKt9q5vhMjfQQHN2DRXN` was created natively, rescheduled without changing ID, concurrently edited through an authenticated callable to induce stale-save rejection, then cancelled natively. A separate callable-seeded practice was completed natively. Raw captures and SHA-256 manifest remain in `/private/tmp/p202-ui/`; no screenshots are source commits and none may be recaptured after review fixes.
- On 2026-10-15 the human authorized replacing Greptile with GitHub Codex review for P2.02 and all remaining Phase 2 steps. `AGENTS.md` now requires the exact `@codex review` trigger, verified bot identity and exact-head linkage, addressed/dispositioned findings, passing relevant CI and original evidence. Historical P2.01 Greptile 5/5/merge provenance and P2.02 credit-limit notices are retained. At prior frozen head `d854212fd6efb702dc37909c6a62800de836c702`, all three CI jobs and the clean local 136/136 backend run passed; the workflow substitution commit requires its own refreshed CI and review.
- GitHub `chatgpt-codex-connector[bot]` completed [review 5536637347](https://github.com/orkunozekin/team-hangout/pull/26#pullrequestreview-5536637347) against exact head `4c7a5eaf5b8cef2a1a98c5202ff8725265622275`. Its P1 organization-timezone default and P2 repeated event-read findings are addressed: the authorized team reader returns the validated organization zone; new forms default to it and retain it in selectable zones. Document snapshots, identical management checks and household discovery are reused only within a read transaction attempt. New tests cover Phoenix defaults, missing-zone refusal, 50-event read counts, revocation before the next request and a fresh cache on another transaction attempt. Review-fix validation passes: native typecheck, Functions build, 146 unit/component tests with coverage and the full 139-test backend suite including deletion. Original screenshots remain unchanged and do not depict these later review fixes. Re-review and CI must target the new fix head on PR #26.
- Codex [re-review 5536788957](https://github.com/orkunozekin/team-hangout/pull/26#pullrequestreview-5536788957) at `c3bd2267f8503a202f9fcddaf10a99f47b80e098` identified two further valid issues. Published v2 detail edits now require the lifecycle command so legacy `updateEvent` cannot omit reason/history; authorized replay and unpublished single-event draft promotion remain compatible. Recent history reads one sentinel row so exactly 20 records is complete and 21 correctly reports older history. Regressions cover both mutation entry points and 19/20/21 history sizes. Validation passes: Functions build, native typecheck, all 146 unit/component tests with coverage and the full fresh 141-test backend suite. Original screenshots remain unchanged.
- Codex [review 5536929044](https://github.com/orkunozekin/team-hangout/pull/26#pullrequestreview-5536929044) at `1a83c2df6448ab92024eb93ee1d042e0f7708b84` found canonical display-time sorting and omitted captain management grants. Sorting now uses canonical `startsAt`, with mixed-zone/repeated-DST-hour regressions and legacy ordering retained. Captain management is explicitly authorized by the approved product plan audience table and this plan's `/teamMembers` contract. Server scope and native controls accept active captain grants while retaining every-team authorization, tenant/hierarchy checks and replay revocation. Validation passes: Functions build, native typecheck, 148 unit/component tests with coverage and the full fresh 142-test backend suite. Original UI captures remain unchanged and do not depict these fixes. This is the third bounded fix round; request exact-head Codex re-review after validation, and report additional valid findings if that review does not converge.
- Codex [review 5537131582](https://github.com/orkunozekin/team-hangout/pull/26#pullrequestreview-5537131582) at `7a00d7c10830c3204f1625443963f99501e8c3eb` identified the canonical Team tab's denied legacy directory query and revoked preferred membership selection. Canonical Team tabs now load the authorized team, omit legacy roster/invite tools, explain organization roster management and offer handled retry/refresh. Legacy member lists/invites remain available. Discovery filters inactive canonical assignments and tries another candidate if a live team read is denied/missing; service failures still surface. Synthetic platform-support navigation remains legacy-only. Native regressions cover canonical/legacy rendered tabs, errors/retry/team switching, revoked/pending preferred grants, live denial fallback and service failure. Emulator coverage proves self-owned revoked assignments stay readable, canonical roster directory queries remain denied and current team reads recheck revocation. Validation passes: native typecheck, Functions build, 155 unit/component tests with coverage and the full fresh 143-test backend suite. Original screenshots are unchanged and do not depict these fixes.
- The human explicitly overrode the three-round stop after that review. Continue P2.02 fixes/re-reviews until all valid actionable findings are addressed and a completed exact-current-head GitHub Codex review plus relevant CI passes, or report an actual external blocker/material decision. `AGENTS.md` now asks for a complete diff/caller/screen pass including P0/P1/P2 correctness/security/privacy, live grants/tenant boundaries, compatibility/history, timezone/DST, pagination/performance and meaningful rendered regressions. No numeric score replaces this gate. Future UI PRs use one representative screenshot by default, at most two when essential; PR #26 retains all 11 original attachments. Commit handoff before requesting final review, then freeze head and record settling gates in PR comments. No merge or P2.03 is authorized here.
- P2.02 introduces no migration, deployment, production access or flag changes. Deploy new callable readers/lifecycle endpoints and verify declared query indexes before releasing the native adapter. Facility occupancy is P2.03, recurrence is P2.04, bulk commit-marker visibility/publication is P2.07, responses/reconfirmation are P2.09 and completion roster snapshots are P2.10. Existing agenda/feed scheduled-only behavior and null-marker compatibility remain in place; all operation-marked events stay hidden here.

- Product scope translated into contracts, bounded PR steps, feasibility evidence, explicit prototype gates and external release dependencies.
- Existing native/server source and owner-app recurrence/RSVP/check-in logic inspected read-only.
- Official SDK54 documentation re-read before P2.02 code. Earlier planning supplied feasibility evidence only; the P2.02 implementation and runtime evidence are now recorded above. No deployability claim is made.

### Remaining work

- Obtain a completed GitHub Codex code review tied to the exact current head of P2.02 PR #26, address or disposition all actionable findings, and verify passing relevant CI, original evidence and branch protections; coordinator independently verifies and merges. The human authorized this replacement of Greptile 5/5 on 2026-10-15; no numeric score is required for this and remaining Phase 2 steps. No merge is authorized in this implementation chat. **P2.03** is next only after that gated merge; do not start it here.
- At the end of each step record PR, verified test evidence, migration status, next step and blockers here; do not mark later steps complete by association.
- Preserve current account/team behavior during compatibility migration; update account deletion for all added user/access/device paths before release.

### Blockers and risks

- Historical P2.02 [Greptile availability notice](https://github.com/orkunozekin/team-hangout/pull/26#pullrequestreview-5527728097) reports exhausted credits and supplied no code review or 5/5. On 2026-10-15 the human explicitly replaced that gate with the GitHub `@codex review` bot for this and remaining Phase 2 steps. A completed review must identify the exact current head; setup/access/unavailable responses are blockers, not approval. Macroscope skips remain non-approval. Preserve existing branch protections and original screenshots. Current CI and Codex review on PR #26 are authoritative; do not create ledger-only commits to record a settling gate.
- Bounded league scheduler feasibility, native binary upload, real push/email, scanner infrastructure and staging indexes require the listed proofs.
- Database edition, deployment billing/IAM, email service, push credentials and physical device availability were not verified by this planning document.
- Privacy policy decisions remain explicitly gated; commercial model selection remains pending.

### Pointers for next agent

- Start at `functions/src/operations/events.ts`, `src/firebase/events.ts`, `src/lib/eventTime.ts`, existing event screens and `tests/backend/operational-events.test.mjs`. Read PR #26 before advancing; do not mistake implemented/in-review for merged.
- Do not port account-only RSVP identity, automatic no-show inference, unsupported native persistence/upload assumptions, or claims of exactly-once external delivery.
- Treat source/API evidence as feasibility support; attach actual runtime/test proof as each capability is implemented.

### P2.01 delivery ledger

| Chat | Branch | PR | Head | Review |
| --- | --- | --- | --- | --- |
| `01a13d66-11c8-7a93-a9fc-c4c410a91ca6` | `codex/p2-01-operational-contracts` | [#25](https://github.com/orkunozekin/team-hangout/pull/25) | Final head `a9fc21ddc5967c7213f5c6e52a29a5b403e08fff`; squash `db2ca81a072ff1fb5b9d3c9f9ffee18a9f6c4420` present on fetched main | Merged. Explicit Greptile 5/5 at final head and all three CI jobs passed; no review threads. Earlier 5/5 at `f8bb02f` is historical, not the final gate. |


### P2.02 delivery ledger

| Chat | Branch | PR | Source/evidence | Review |
| --- | --- | --- | --- | --- |
| `01a13d7c-23ff-77b1-a2aa-abc558d645c2` | `codex/p2-02-canonical-events` | [#26](https://github.com/orkunozekin/team-hangout/pull/26) | Initial UI source `a56a17e4ad50a214d679b6f715565b642fd86449`; form source `bcea905`. Current PR head includes this handoff and is authoritative. 11 original attachments in the PR; native 144 tests and backend 136 tests validated as described above. | Implemented, not merged. Historical Greptile credit exhaustion is preserved above. Human-authorized 2026-10-15 substitution: completed exact-current-head GitHub Codex review, all actionable findings addressed/dispositioned, passing CI, original evidence and branch protections. Initial Codex review at `4c7a5ea` found P1 timezone defaults and P2 repeated reads, now addressed with regression tests. Re-review at `c3bd226` additionally found compatibility edit/history bypass and a history sentinel off-by-one, now addressed. The third fix round addressed instant ordering and plan-authorized captain management. The human overrode the round limit; canonical Team tab compatibility and revoked assignment selection are now addressed. Final fix-head full-diff Codex review including P2 findings and CI are pending; linked PR is authoritative. |
