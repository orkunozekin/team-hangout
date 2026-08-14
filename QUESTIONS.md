# Open questions & locked decisions

Decisions made while you were away. Change anything you disagree with.

## Locked decisions

| Topic | Decision |
|-------|----------|
| White-label model | One multi-tenant app; coaches create teams inside it (not per-team app binaries) |
| Backend for MVP | Firestore client + security rules only — no Next.js API |
| Auth | Email/password only; Firebase `sendPasswordResetEmail` |
| Roles | `coach` (creator) and `player` |
| Invites | 8-char alphanumeric codes via `inviteCodes/{code}` lookup docs + deep link `teamhangout://join?code=XXXXXXXX` |
| Events | `practice` \| `match`; coach CRUD; players read |
| Filters | All / Practice / Match; sort by date then time ascending |
| Sport | Sport-agnostic naming; optional free-text `sport` on team |
| Out of scope | RSVP, geo check-in, chat, payments, web admin, Google Sign-In, push notifications |

## Peer-review adjustments applied

1. Added `inviteCodes/{code}` → `{ teamId }` so join does not need insecure `where('inviteCode'==…)` queries.
2. Invite codes are **8 characters** (not 6) for better entropy.
3. Firestore rules enforce membership isolation and coach-only event writes.

## Questions for you

1. **Firebase project:** Confirm you will create a new Firebase project (Auth + Firestore) separate from Soccerville and paste config into `.env.local`.
2. **Google Sign-In:** Do you want Google OAuth in v2 (needs a small backend / Cloud Function for the mobile token bridge)?
3. **Multi-team users:** Should a user belong to multiple teams and switch `activeTeamId`, or stay single-team for now? (Implemented: one active team; joining another replaces active membership context via `activeTeamId`.)
4. **Invite expiry / rotation:** Should invite codes expire, or only rotate when the coach regenerates? (Implemented: no expiry; coach can regenerate.)
5. **Domain:** What production domain should deep links / marketing use later (e.g. `teamhangout.app`)?
6. **EAS project:** Create an EAS project and add `extra.eas.projectId` to `app.json` when ready to ship builds.
7. **Rules emulator tests:** Should we add `@firebase/rules-unit-testing` in a follow-up PR? (Not in this MVP.)
