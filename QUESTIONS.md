# Open questions & locked decisions

Decisions made while you were away. Change anything you disagree with.

## Locked decisions

| Topic | Decision |
|-------|----------|
| White-label model | One multi-tenant app; coaches create teams inside it (not per-team app binaries) |
| Backend for MVP | Firestore client + security rules; Callable Cloud Function for account deletion only |
| Auth | Email/password + Google Sign-In + Sign in with Apple (native; requires development build) |
| Roles | Team: `coach` / `player`. Platform: `appRole` `user` / `superAdmin` for app owners |
| Invites | 8-char alphanumeric codes via `inviteCodes/{code}` lookup docs + deep link `teamhangout://join?code=XXXXXXXX` |
| Events | `practice` \| `match`; coach CRUD; players read |
| Filters | All / Practice / Match; sort by date then time ascending |
| Sport | Sport-agnostic naming; optional free-text `sport` on team |
| Out of scope | RSVP, geo check-in, chat, payments, web admin, push notifications |

## Peer-review adjustments applied

1. Added `inviteCodes/{code}` → `{ teamId }` so join does not need insecure `where('inviteCode'==…)` queries.
2. Invite codes are **8 characters** (not 6) for better entropy.
3. Firestore rules enforce membership isolation and coach-only event writes.

## Questions for you

1. **Firebase project:** Confirm you will create a new Firebase project (Auth + Firestore) separate from Soccerville and paste config into `.env.local`.
2. **Google Sign-In:** Implemented with `@react-native-google-signin/google-signin` + Firebase credentials (no Cloud Function). Requires a development build.
3. **Multi-team users:** Should a user belong to multiple teams and switch `activeTeamId`, or stay single-team for now? (Implemented: one active team; joining another replaces active membership context via `activeTeamId`.)
4. **Invite expiry / rotation:** Should invite codes expire, or only rotate when the coach regenerates? (Implemented: no expiry; coach can regenerate.)
5. **Domain:** What production domain should deep links / marketing use later (e.g. `teamhangout.app`)?
6. **EAS project:** Create an EAS project and add `extra.eas.projectId` to `app.json` when ready to ship builds.
7. **Rules emulator tests:** Should we add `@firebase/rules-unit-testing` in a follow-up PR? (Not in this MVP.)


8. **Super admin bootstrap:** First owner must set `users/{uid}.appRole = "superAdmin"` in Firebase console (clients cannot self-promote). After that, super admins can promote others via `setUserAppRole` (rules-enforced).

## Phase 2 P2.15 reminder decisions

These choices are locked for the server reminder and staff diagnostics step. The older MVP "out of scope" row above is historical and does not override the Phase 2 product plan.

| Topic | Decision |
|-------|----------|
| Reminder identity | One reminder per schedule version and deadline instant. A moved deadline or reschedule plans a new key. A sent reminder is not recalled and is not the new key's reminder. |
| Timing | Send at 24 hours before the deadline, or once immediately when at least 1 hour and under 24 hours remain. Do not send in the final hour, after the deadline, or for a non-finite deadline. |
| Recipients | Linked participant or guardian with `permissions.respond`. Yes, no, and maybe count as responses. Coaches, staff, and view-only guardians are excluded. One notification per login account. Every active event-team enrollment is kept as its own access source. |
| Flag | `features.rsvpReminders` gates sending and expansion. Inbox, push, and email still follow their own flags. Flag off writes a paused reminder on deadline and lifecycle commands, and a queued reminder intent expands to nobody. |
| Publication | Bulk publication does not write reminder docs inside publication chunks. The start scan prepares published events inside 16 weeks. A separate deadline scan prepares a published event whose RSVP deadline is inside the next 25 hours. |
| Expansion | A pending reminder expands only while its stored key matches the current schedule version and deadline, the event is published and scheduled, the resource is open, the flag is on, and at least one hour remains. |
| Diagnostics | Permanent and unknown transport failures are separate from unacknowledged critical updates. The callable response omits email, token, and recipient id. Read is not acknowledgement. Bounce is not acknowledgement. The admin page loads 25 rows and appends older rows from each cursor. Losing inbox access also deletes that person's critical projection, including a revoked row once its page cursor is consumed. Program staff grants of up to 20 programs are queried in chunks of 10. |
| Staff UI | Web admin Delivery diagnostics only. No new native screen in this step. |

## Phase 2 P2.16 conversation decisions

| Topic | Decision |
|-------|----------|
| Channels | Organization and division announcements are staff-authored adult channels. Team and event channels are youth group channels. There is no direct-message command. |
| Youth posting | Guardians and linked participants can read a team or published event channel immediately. They can post only after `policies.youthChannels` is `approved`. Staff and coaches can post before that approval. |
| Staff notes | Notes live under `staffNotes`, not in the household channel. Only org admins and program staff for that scope can read or write them. Coaches, guardians, notifications, and the outbox do not receive the note text. |
| Moderation | Program staff and org admins can tombstone a message and remove its text. Coaches can pin up to three messages. Guardians cannot pin or moderate. |
| Flag | `features.conversations` must be true. It is not enabled by this change. |
| Native entry | A household calendar opens organization and division announcements only for a team that lists a participant, plus that team's channel and each loaded event channel. A coach-only team and the Team tab open the team channel. Event detail opens the published event channel. Offline copies hide these actions. |

## Phase 2 P2.17 correction and search decisions

| Topic | Decision |
|-------|----------|
| Pages | Newest-first sequence pages stay at 25 by default and accept 1 through 50. The cursor names the sequence and message id and is rejected when that pair is not in the channel. |
| Edits | Only the author can replace text, with the current message revision and a new request id. The edit audit stores actor, revision, and time, not the previous text. |
| Tombstones | Moderation still removes the text, keeps the sequence, deletes search tokens, and writes the same redacted audit. |
| Reactions | Seven emoji. A second tap removes the caller's reaction. Youth posting must be open before a guardian or player can react. Staff and coaches can react before that approval. |
| Search | Exact words of at least two letters or numbers, at most five query words and 200 indexed words. The private index is scanned 200 at a time, capped at 1,000 candidates, and returns `partial` with a signed cursor only when another candidate or unfinished history backfill remains. Each search indexes at most 100 older messages that predate the index, re-reading those messages in a transaction. An unfinished backfill returns a restart cursor so a later index row is not skipped. Staff notes stay out of search, push, and email. |
| Cursor key | `CONVERSATION_SEARCH_CURSOR_KEY` is a JSON key ring. The active version signs new cursors and the previous version still verifies. The demo emulator uses a public synthetic ring. |
| Flag | `features.conversations` is still not enabled by this change. Direct messages stay rejected. Account deletion still does not anonymize authors. Attachments stay a later step. |

## Phase 2 P2.18 attachment transport decisions

| Topic | Decision |
|-------|----------|
| Flag | `features.attachments` is separate from `features.conversations`. Both must be true. New organizations still receive only `features.organizationV2`. The picker stays hidden until the server reports attachments enabled and the caller can post. |
| Grant | HMAC upload grant, 5 minutes. The demo emulator uses `demo-attachment-upload-key-v1-do-not-use-live`. Production requires `ATTACHMENT_UPLOAD_KEY` of at least 32 characters and fails closed. The storage emulator has no signed URLs, so PUT and GET use the `attachmentTransport` HTTP function. Download is a live bearer ID token, not a saved URL. |
| Bytes | JPEG, PNG, and PDF, 1 byte through 10 MiB. Extension plus magic bytes. Client MIME is not a callable field. Unsafe HTML, SVG, XML, script, MZ, ELF, and shebang content is rejected. At most 3 active files per owner per conversation, tracked on one slot document. |
| Scanner | `developmentScanner` always returns clean after those checks. Quarantine is not downloadable. Rejected bytes are deleted, and a failed delete is retried on the same request id. A missing object is `INTEGRITY`; a transient storage read stays retryable. `messageId` stays null, and a non-null message id is refused, so this path cannot serve a linked file. |
| Privacy | File bytes stay out of messages, search, staff notes, notifications, and the outbox. Youth posting gates reserve, PUT, and finalize. Download uses read access, so a guardian can fetch a staff file while posting is closed. Direct messages stay rejected. |

## Phase 2 P2.19 quarantined attachment decisions

| Topic | Decision |
|-------|----------|
| Scanner | The production default is the built-in `content` scanner. It strips JPEG, PNG, and PDF metadata and rejects active PDF content. No new secret is required, so an unavailable external product does not block the step. `platformConfig/attachmentScanner.mode` of `unavailable` or an unknown mode rejects the file as `SCAN_FAILED`. `external` also requires `ATTACHMENT_SCANNER_URL` over `https`. That URL is not stored in Firestore. The content scanner runs before the external POST. A failed or unclean external response never marks a file ready. |
| Codes | `INTEGRITY` and `ACCESS_REVOKED` stay transport results. They are not scanner verdicts. `SIGNATURE_MISMATCH` and `UNSAFE_CONTENT` are decided before the scanner. `ACTIVE_CONTENT` comes from the content scanner. |
| Linking | A message stores at most 3 ready attachment ids owned by the author. Linking releases the reservation slot in the same transaction. Edits stay text-only. Staff notes reject the field. File names are not search tokens. |
| Download | A ready file with a null `messageId` stays downloadable by a conversation reader. A linked file requires the live message to include that id and not be tombstoned. The handler hashes a stream and sends a second stream only when the hash and length match. |
| Cleanup | `pending`, `uploading`, `quarantined`, `canonicalizing`, and `rejected` rows older than 24 hours are purged. Object listing saves a page token so a later run continues through the prefix. Ready rows are kept. Account deletion still does not anonymize `ownerUid`. A tombstone does not delete bytes. |
| Canonical bytes | Stripped bytes are written to object `/2` only after the row is `canonicalizing`. A replay of the upload grant cannot replace that object. Recovery compares the canonical hash and length, including after the original grant expires. PDF metadata is blanked in place so xref offsets stay valid. PDF names are hex-decoded, and Flate, ASCII85, and ASCII hex streams are decoded before the active-content check. An external scanner cannot return `INTEGRITY` or `ACCESS_REVOKED`. Changing channel clears unsent files. |
| Flag | `features.attachments` stays off for new organizations. Both conversation and attachment flags must be true. |

## Phase 2 P2.20 pilot decisions

| Topic | Decision |
| --- | --- |
| Pilot gate | Phase 2 code is complete. It is not pilot-ready. This step does not deploy, create secrets, or start Phase 3. |
| Attachments | Seed a multi-team pilot only after `ATTACHMENT_UPLOAD_KEY` exists. Leave `features.attachments` off until the scanner kill switch, external outage, grant expiry, and purge drills pass. |
| Rollback | `applyPilotRollback` turns scheduler, attendance, location assistance, conversations, attachments, RSVP reminders, and the three notification channel flags off. It keeps `organizationV2`, `adminWorkspace`, and `households`. In-flight publications become `quarantined` in pages of 20 and are not resumed when the scheduler flag is turned back on. |
| Deletion audit | Account deletion counts `attachments.ownerUid` onto the job and leaves the bytes. It does not anonymize `ownerUid` or message `authorUid`. Retention stays an owner policy. |
| Dashboard | Org admins read counts, flags, stuck publications, rejection codes, and scanner mode. The page omits names, tokens, owner ids, and file names. |
| Memory | Finalize and download hold up to 10 MiB in a 512 MiB function. A real 10 MiB transfer is a staging drill, not an emulator claim. |
