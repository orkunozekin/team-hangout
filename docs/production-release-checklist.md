# Production release checklist

Ordered steps to stand up the Phase 1-3 backend in production project `team-hangout-ddf27`. Nothing here has been run against production. Every step marked **OWNER** needs an explicit owner decision or action in chat before it happens; agents must not perform it on their own. Rehearse each step on `team-hangout-staging` first (see [staging deployment record](phase-1-staging-deployment.md)).

## 0. Preconditions

1. **OWNER** Approve the production release in chat, naming the source SHA. It must be a `main` commit already deployed and smoke tested on staging.
2. **OWNER** Confirm Blaze billing, a budget alert, email/password Auth and authorized domains on `team-hangout-ddf27`. Agents do not change billing or plans.
3. **OWNER** Take a Firestore export or confirm point-in-time recovery before any production write. Record the export path privately.
4. Build from a clean checkout of the approved SHA: `cd functions && yarn install --frozen-lockfile && npm run build`. Root app: `yarn install`.

## 1. Secrets (Secret Manager, production only)

Each value is generated with a CSPRNG and piped straight into the CLI, never printed, logged or committed. Never reuse staging or demo values.

1. **OWNER** `ATTACHMENT_UPLOAD_KEY` (>= 32 random bytes): `openssl rand -base64 48 | firebase functions:secrets:set ATTACHMENT_UPLOAD_KEY --data-file=- --project team-hangout-ddf27`.
2. **OWNER** `CONVERSATION_SEARCH_CURSOR_KEY` (>= 32 random bytes), same pattern.
3. **OWNER** `INVITATION_DELIVERY_KEY` (>= 32 random bytes), same pattern.
4. **OWNER** `ESSENTIAL_EMAIL_API_KEY`: needs a real email provider account and sender domain. Blocked until the owner chooses a provider and approves email policy. Without it the Functions source cannot load `resumeEssentialEmail`, so either create it with the provider key or deploy with that export excluded (see step 3.3).
5. Verify with `firebase functions:secrets:describe <NAME> --project team-hangout-ddf27` (shows versions only, not values).

## 2. Functions environment

`functions/.env.*` files are git-ignored by design so project settings and secrets never enter source. Create `functions/.env.team-hangout-ddf27` locally with the same keys as the staging file and these safe values:

| Key | Production value | Note |
| --- | --- | --- |
| `IMPORT_BUCKET` | production Storage bucket name | **OWNER** confirms bucket |
| `IMPORT_RETENTION_DAYS` | e.g. `30` | **OWNER** approves real participant data retention; staging uses 1 day for fixtures only |
| `ESSENTIAL_EMAIL_ENABLED` | `false` | Turn on only after provider and policy approval |
| `ESSENTIAL_EMAIL_POLICY_APPROVED` | `false` | **OWNER** policy decision |

Staging-only scaling bounds (min 0, max 2, concurrency 1) are keyed on the staging project id and do not apply to production. **OWNER** decides production min/max instances if defaults are not acceptable.

## 3. Deploy, in this order

All commands use explicit `--project team-hangout-ddf27`. Each step is **OWNER** gated.

1. **OWNER** Indexes first: `firebase deploy --only firestore:indexes --project team-hangout-ddf27`. Poll `firebase firestore:indexes --project team-hangout-ddf27` and the console until every composite index in `firestore.indexes.json` is READY. Do not continue while any index is building.
2. **OWNER** Storage rules: `firebase deploy --only storage --project team-hangout-ddf27`.
3. **OWNER** Functions: `firebase deploy --only functions --project team-hangout-ddf27`. Deploy in batches of at most ten (`--only functions:a,functions:b,...`) if first-time provisioning races occur, and retry only the failed names. If `ESSENTIAL_EMAIL_API_KEY` does not exist, the email worker must be excluded first; it is only auto-omitted for staging today, so this needs a code change or the secret. Verify every export is ACTIVE with `firebase functions:list`.
4. **OWNER** Firestore rules last: `firebase deploy --only firestore:rules --project team-hangout-ddf27`. Rules go after callables so new clients never reach rules that expect missing backend paths.
5. Record deployed SHA, function count, index READY count and rules release in a production evidence file under `docs/evidence/`.

Hosting for the browser admin workspace is a separate **OWNER** decision (site, target binding and production build config).

## 4. Legacy migration window

Follow [legacy migration](legacy-migration.md) exactly.

1. **OWNER** Approve the migration window and announce it to existing users.
2. Generate the plan (dry run) read-only against production, review the entire saved plan privately and note its SHA-256.
3. **OWNER** Approve the plan checksum, then `apply` with that exact checksum. Resume interruptions with the same saved plan; never regenerate from partial data.
4. Reconcile: checkpoint count equals planned operations and every target equals its postimage. Rerun the same file to confirm idempotency.
5. The live cutover for legacy invite codes stays gated per the migration doc. Do not run it without the owner gate named there.

## 5. Per-organization flag enablement

Flags are per organization and never replace authorization. Enable them one organization at a time, smallest pilot first, each one **OWNER** approved.

1. `organizationV2`, `adminWorkspace`, `households` (Phase 1 base).
2. Phase 2 writers, each independently: `scheduler`, `attendance`, `locationAssistance`, `conversations`, `rsvpReminders`, `notificationInboxFake`. `attachments` only after `ATTACHMENT_UPLOAD_KEY` exists and the scanner drill in the [Phase 2 runbook](phase-2-pilot-runbook.md) passed on staging.
3. **OWNER** `notificationPush` (real push sends) and `notificationEmailFallback` (real email) only after provider, policy and pilot enrollment decisions.
4. Phase 3 capabilities per the [feature plan](features/phase-3-coaching-competition-feature-plan.md): rides, reports, rollover and resources flags. Coaching, results, brackets and volunteers have no per-organization flag yet and are live once functions deploy, behind live authorization.
5. **OWNER** Turn on `platformConfig/phase3Monitoring.enabled` once alert routing is agreed.

## 6. Rollback

- Stop new writes by setting the affected organization flags to `false` (table in the Phase 2 runbook). Leave `organizationV2`, `adminWorkspace` and `households` on so staff can read history.
- Schedule publication: call rollback repeatedly until `truncated` is false.
- Functions: redeploy the previous approved SHA (**OWNER**). Rules: redeploy the previous rules file (**OWNER**). Do not delete indexes during rollback.
- Migration: follow the reverse-checkpoint procedure in the migration doc, only before post-migration edits or grants (**OWNER**).
- Never delete immutable ledger, audit or prior-season data to make rollback easier. Restore from the step 0 export only as a last resort (**OWNER**).
