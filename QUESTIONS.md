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
