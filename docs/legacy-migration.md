# Reviewed legacy migration rehearsal

## Live operator procedure (staging and production)

`scripts/migrations/legacy-live.mjs` is the reviewed live entry point. The demo-only `legacy.mjs` below is unchanged. The live tool reuses the same plan/apply core and adds: a required `--project` from an exact allowlist (`demo-team-hangout`, `team-hangout-staging`, `team-hangout-ddf27`), refusal when emulator hosts or a mismatched `GCLOUD_PROJECT`/credential `project_id` are present, a read-only `--dry-run`, an `--apply` that requires the saved plan's checksum plus `--confirm-project <same id>` and `--writers-stopped`, and a read-only `--reconcile`. All argument and environment guards run before a Firebase client is created. Running it against production still needs explicit owner approval of the mapping manifest, the plan checksum and the maintenance window; this document is not that approval.

Credentials: real projects use Application Default Credentials (`GOOGLE_APPLICATION_CREDENTIALS` pointing at an owner-approved key, or `gcloud auth application-default login`). The Firebase CLI login is not used. Never commit or print the key.

1. Prerequisites. Deny-first rules and the scoped readers/commands from Phase 1 are deployed to the target. Organization/program/season/division parents exist and are active v2 with `features.organizationV2: true`. Copy `scripts/migrations/manifest.example.json` outside the repository and fill one reviewed mapping per legacy team (org/program/season/division, IANA timezone, default duration, `confirmedBy`). An empty `mappings` array is allowed for an inventory-only plan.
2. Dry-run (read-only). The whole inventory is read inside a Firestore read-only transaction, which the server rejects if any write is attempted, and the tool issues none. The plan file is created exclusively with mode 0600 and contains private preimages; keep it out of source control under the approved retention policy. Console output is aggregate-only: checksum, source/target counts, mapped/unmapped teams, blocking issues, orphans, coach assignment count, distinct owners, timezones and default durations. The plan file's `report` holds the detail (`mappings` with owner/timezone/duration, `coachAssignments`, `issues`, `orphanPaths`, `unmappedTeamIds`). Exit code 2 means blocking issues or orphans: fix the source or manifest and dry-run again.
3. Review and approve the printed checksum. The checksum covers the project ID and generation time, so a plan cannot be replayed against another project. A fresh apply refuses plans older than 24 hours.
4. Stop writers. Disable legacy client writes and new entry points for the whole apply/reconcile window, then apply. `--max-operations N` bounds a session; any interruption (crash, Ctrl-C, `--max-operations`) resumes by rerunning the identical command with the same plan file. Completed operations are verified, never rewritten, and a resumed run is not subject to the 24 hour limit.
5. Reconcile. A complete apply runs access reconciliation automatically (exit 3 on mismatch): every member of each mapped team must be in the approved plan, migrated with roles matching the legacy role, and each player must have an active roster entry and a linked participant. Rerun it any time read-only with `--reconcile --plan ... --checksum ...`. Rerunning `--apply` after completion is an idempotent replay that reports the same result and rewrites nothing.
6. Rollback stays manual and pre-edit only, as described below. A production rollback worker is not implemented.

The emulator suite `tests/backend/migration-live.test.mjs` rehearses this procedure on a synthetic multi-org, multi-timezone dataset in an isolated named emulator database: refusals (no/unknown project, missing checksum or confirmation, project mismatch, emulator mixing), proof that inventory only uses a read-only transaction and changes nothing, blocking orphans, interrupted apply and resume, idempotent replay and access drift detection.

### Staging rehearsal commands

Staging needs ADC for `team-hangout-staging` (gcloud is not installed on the owner workstation yet). With credentials in place and synthetic `@example.test` legacy data seeded in staging:

```sh
export PRIVATE_DIR="$(mktemp -d)"; chmod 700 "$PRIVATE_DIR"
unset FIRESTORE_EMULATOR_HOST FIREBASE_AUTH_EMULATOR_HOST
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/approved-staging-key.json   # or gcloud ADC
cp scripts/migrations/manifest.example.json "$PRIVATE_DIR/manifest.json"     # then edit reviewed mappings
npm --prefix functions run build
node scripts/migrations/legacy-live.mjs --project team-hangout-staging --dry-run --manifest "$PRIVATE_DIR/manifest.json" --out "$PRIVATE_DIR/plan.json"
SHA=<checksum printed above, after review>
node scripts/migrations/legacy-live.mjs --project team-hangout-staging --apply --plan "$PRIVATE_DIR/plan.json" --checksum "$SHA" --confirm-project team-hangout-staging --writers-stopped --max-operations 5
node scripts/migrations/legacy-live.mjs --project team-hangout-staging --apply --plan "$PRIVATE_DIR/plan.json" --checksum "$SHA" --confirm-project team-hangout-staging --writers-stopped
node scripts/migrations/legacy-live.mjs --project team-hangout-staging --apply --plan "$PRIVATE_DIR/plan.json" --checksum "$SHA" --confirm-project team-hangout-staging --writers-stopped
node scripts/migrations/legacy-live.mjs --project team-hangout-staging --reconcile --plan "$PRIVATE_DIR/plan.json" --checksum "$SHA"
```

The first apply simulates an interruption, the second resumes to completion with automatic reconciliation, the third is the idempotent replay.

## Demo-only emulator rehearsal (historical)

Step 4 adds offline tooling, not a deployed migration endpoint. The executable deliberately accepts only `demo-team-hangout` and Firestore at `127.0.0.1:8080`. It refuses credential overrides. No production data was read, no rollout flags are changed, and no invitations, guardian grants, self-access projections, emails or outbox jobs are created. Staging/production execution needs a separately reviewed release and owner approval of organization/timezone mappings, deployment inventory and retention policy.

## Review and dry run

1. Build with `npm --prefix functions run build`. Start isolated emulators using `firebase.emulators.json` and the `demo-team-hangout` project; never reuse a real-project alias. Use synthetic fixture data. The complete automated rehearsal is `npm run test:backend`.
2. Copy `scripts/migrations/manifest.example.json` outside the repository. Review every team mapping, canonical organization/program/season/division, IANA timezone and default duration. `confirmedBy` records the approving owner, not an inferred role or a grant. `confirmedAt` is an exact UTC ISO timestamp. Never infer ownership from names, emails or creator IDs. Record whether deployed users exist before any future live rehearsal.
3. Stop fixture writers for the entire inventory/apply/reconciliation period. This is a maintenance tool, not an online concurrent migration. Per-record compare-and-set checks detect drift but cannot make the entire multi-record run atomic. Keep all new household/admin/feed/email entry points disabled throughout a partial run. Organization hierarchy must already exist with valid active v2 parents and the Step 3 backend enabled. This tooling does not bootstrap owners or enable feature flags.
4. Run the command below. It reads only and creates a mode-0600 review file with exclusive creation. The file contains source preimages, names and IDs: treat it as private operational data, keep it out of Git, and retain it only under an approved policy. Console output contains counts, identifiers and validation reasons, not document bodies.

```sh
GCLOUD_PROJECT=demo-team-hangout FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
  node scripts/migrations/legacy.mjs dry-run /tmp/reviewed-manifest.json /tmp/reviewed-plan.json
```

Dry-run returns exit code 2 for blocking issues or orphan references. Inspect `report.issues` for invalid timestamps, missing users, noncanonical membership IDs, duplicate mappings, foreign hierarchy, invalid timezones, DST gaps/folds, existing targets and inconsistent invite lookups. `orphanPaths` includes team/member/event/invite references. `unmappedTeamIds` is an explicit remaining inventory, not a default organization. Fix the source/manifest, create a new review file and obtain fresh checksum approval. No malformed row is silently skipped during apply; one blocking issue prevents the whole plan from starting.

`report.sourceCounts` counts top-level inventory documents; `report.counts` counts unique target writes by collection. Player membership count should equal roster count for mapped teams. Participant count can be lower because one UID within one organization produces one deterministic SHA-256-based ID. The same UID in a second organization produces another ID; same-name UIDs remain distinct. Coaches retain their assignments but do not get player participants. User profile names are canonical; names never determine identity. No guardian/self-link authorization is inferred.

## Apply, resume and reconcile

Review the entire saved plan, then pass its printed SHA-256 checksum explicitly:

```sh
GCLOUD_PROJECT=demo-team-hangout FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
  node scripts/migrations/legacy.mjs apply /tmp/reviewed-plan.json APPROVED_CHECKSUM
```

Keep the same saved plan after interruption; do not regenerate it from partially converted data. Each transaction writes one target and its checkpoint under `legacyMigrationRuns/{runId}/checkpoints/{index}`, including exact before/after images and the approved plan checksum. Reads are bounded to that target/checkpoint and its relevant hierarchy/user dependencies. The manifest fixes the run ID; a changed plan under the same manifest is rejected. Completed operations verify their postimage and do not rewrite it. A changed source, target or dependency stops the run for review, preserving progress. Do not overwrite checkpoints or bypass a drift error.

Completion requires checkpoint count equal to planned operation count and every stored target equal to its planned postimage. Rerun the same file/checksum to verify identical IDs, counts and content. Retained timestamps include nanoseconds, legacy date/time, creators and soft-deletion values. Event revisions advance; converted event instants use the legacy UTC calendar-date label plus `time` in the reviewed timezone. This avoids converting the date label twice. DST gaps and folds block the plan, including half-hour transitions. Default duration is elapsed minutes, recorded as `durationSource: migrationDefault`; converted events remain `publicationState: staged` with `timeSource: legacyConverted`. They never publish or send mail here.

Legacy invite strings and lookup IDs remain intact. Lookups receive organization scope and `legacyIntent: playerJoinOnly`; they grant no named-child, guardian or staff rights. The existing legacy callable refuses v2 teams. Accepting legacy codes for migrated enrollment remains gated on the Step 5/9 command boundaries, not an unsafe fallback in this tool.

## Read compatibility and rollback

Unmapped teams, memberships, events and invite lookups receive zero writes and remain usable through the tightened legacy rules/callables. Mapped records retain their IDs and legacy fields, but current native legacy team/event reads intentionally deny v2 teams. **Do not run a live cutover before the expanded scoped readers, participant commands and UI are deployed and verified.** Retaining fields is storage compatibility, not proof that an old binary can read migrated teams. Step 4 changes no running screen and needs no UI screenshot.

For a failed synthetic rehearsal, keep the private plan and checkpoints, stop writers, disable new entry points/jobs, and inspect the failure. To roll back data before any post-migration edits or grants, process existing checkpoints in reverse index order in a server transaction per target: require the current document exactly matches `after`; restore `before` with a full set, or delete the target only if `before` is null. Record a separate rollback audit and mark the run rolled back; never reuse the run ID afterward. Stop on any mismatch. Do not blindly restore over later roster/grant/event edits, delete organization history, discard audit evidence or reopen insecure client writes. After later legitimate edits, prefer disabling new entry points and repairing forward under a newly reviewed plan. A future production rollback worker and retention policy require review before enabling live execution.

The emulator suite proves two identical plans, interrupted apply/resume, two complete executions, count/postimage reconciliation, separate same-name participants, preserved soft deletion/timestamps, unchanged unmapped records and actual authorized legacy reads. It also proves mapped v2 teams remain denied to the legacy client, malformed input blocks apply, and changed targets/hierarchy are refused. This is synthetic evidence, not production migration approval or a claim that household access is implemented.
