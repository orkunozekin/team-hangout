# Staging parity deployment, 2026-10-31

Source: `origin/main` at `09de28bf8bfdaa165e80a7d979dd5baa67ede11b`. Project: `team-hangout-staging` only. Production `team-hangout-ddf27` was not touched.

Command: `firebase deploy --only functions,firestore,storage --project team-hangout-staging --non-interactive`, using the git-ignored local `functions/.env.team-hangout-staging` (email enabled and policy approved both false). Result: Deploy complete, exit 0, no retries needed. Hosting was not redeployed.

- Functions: [182 exports](functions.json), all ACTIVE, nodejs22, us-central1, maxInstances 2, concurrency 1. 59 Phase 3 functions were created in this run; the rest were updated. `resumeEssentialEmail` is absent as designed for staging.
- Firestore rules compiled and released. Storage rules compiled; already up to date.
- Indexes: [deployed inventory](indexes.json) has 61 composite indexes and 14 field overrides, matching all 61 definitions in `firestore.indexes.json` (0 missing, 0 extra). Per-index READY state was not verified: the Firebase CLI listing omits state, gcloud is not installed, and the Firebase MCP index listing tool was unavailable. Check READY in the Firebase console before running writers.
- Secrets: `ATTACHMENT_UPLOAD_KEY`, `CONVERSATION_SEARCH_CURSOR_KEY`, `ESSENTIAL_EMAIL_API_KEY` and `INVITATION_DELIVERY_KEY` already existed on staging (version 1, ENABLED). None were created or changed. Values were never read.

No synthetic data was written and no flags were changed. Production steps are in the [production release checklist](../../production-release-checklist.md).
