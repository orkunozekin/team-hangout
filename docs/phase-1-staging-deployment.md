# Phase 1 staging deployment record

Owner approved staging deployment and small synthetic test fixtures in chat on 2026-10-13. Project: `team-hangout-staging` (`130060287753`). Budget target: $10 with a few dollars of overage acceptable; the $10 alert is not a hard cap. Large 5,000-row imports remain on hold until cost estimation and usage review. Production, live email, migration and pilot enrollment are outside this approval.

## Configuration

- Firestore Standard `(default)` is verified in `us-central1`; Storage bucket is `team-hangout-staging.firebasestorage.app`.
- Owner reports Blaze, $10 budget alert, email/password Auth enabled, and authorized domains `team-hangout-staging.firebaseapp.com`, `team-hangout-staging.web.app`, `localhost`.
- Browser uses ignored local public staging configuration, region `us-central1`, emulator connections off. Backend project configuration is now ignored too, to prevent accidental staging settings or secrets entering source.
- Staging-only Functions global options set `minInstances: 0`, `maxInstances: 2`, `concurrency: 1`. This reduces idle/parallel compute exposure, but does not cap total requests, total project instances or spend. Other project defaults remain unchanged.
- Live delivery is disabled by both `ESSENTIAL_EMAIL_ENABLED=false` and `ESSENTIAL_EMAIL_POLICY_APPROVED=false`. `resumeEssentialEmail` is omitted from deployment; no provider key or sender is configured. Required invitation encryption uses a new staging-only Secret Manager key, never client configuration.
- Synthetic import retention is one day, for test fixtures only, not acceptance of real participant/contact retention policy.

## Installation and evidence

The initial Node 22.23.3 Functions and normal browser production builds pass. All 63 exported Functions' deployment metadata have verified staging instance bounds. Backend and browser UI source behavior is unchanged; UI evidence for this resource/configuration change is not applicable. Deployment/smoke results and exact artifact identity will be appended after verification. Storage rules and 13 composite-index definitions were installed first; first readiness inventory reported all 13 CREATING, so readiness is not yet accepted.

Deploy the 62 non-mail-worker exports in batches of no more than ten with explicit `--project team-hangout-staging`. Omit the email worker rather than inventing provider credentials. Apply restrictive Firestore rules after backend commands. Bind Hosting target `admin-staging` to site `team-hangout-staging`, then publish the staging production build. Keep synthetic org flags off until canonical fixture grants exist. No real participant/contact data or calendar bearer URLs belong in logs or Git.

The local production app environment/native service files remain unchanged. Native test-build configuration, actual VoiceOver/TalkBack/browser spoken sessions, hosted calendar subscriptions/log redaction, email callbacks/provider/policy, real migration mappings/separate staging execution, monitoring/support and pilot acceptance all remain open. Deployment approval does not accept those gates or authorize merging this PR.
