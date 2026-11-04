# Phase 1 acceptance record template

Copy one record per gate/session into an approved private evidence location. This blank template accepts nothing. Keep private mappings, names/contact details, Auth tokens, invitation/feed URLs, provider payloads and credentials out of Git. Shared reports use sanitized IDs and counts. Evidence links need authorized viewers and an owner-approved retention date.

## Decision

- Gate/session and exact scope:
- Named accountable owner:
- Tester/operator and reviewer:
- Started/completed date and UTC timestamps:
- Decision: pending / rejected / accepted:
- Decision owner/date; explicit approval reference:
- Remaining defects, restrictions and retest requirement:
- Evidence locations and SHA-256 hashes, including preserved failed attempts:

## Artifact and environment

- Source SHA and clean/dirty status; PR and current-head review/CI:
- Firebase staging project ID; explicit authorization reference:
- Hosting release/version and HTTPS origin; Functions deployed revisions/region:
- Native device build identifier/source/config, OS and assistive technology:
- Config/rules/index/lockfile/artifact hashes; index READY inventory date:
- Storage bucket, Auth providers/domains, service identities, resource/quotas:
- Exact synthetic organization IDs and approved before/after flags:
- Client device/network and backend telemetry attribution method:

## Results

| Workflow/sample | Expected behavior/threshold | Observed result/time | Evidence | Defect/retest |
| --- | --- | --- | --- | --- |
| Pending | Pending | Not run | None | Pending |

For capacity attach all warm timings and p95 computation, cold-start evidence, upload/preview/commit/worker/terminal timestamps, queue/lease/fanout/concurrency, counts/IDs/replay reconciliation and measured reads/index entries/cost attribution. Distinguish operator wait from active processing and successful scenario subsets from whole-run pass.

For accessibility attach actual spoken labels/states/errors, navigation/focus sequence, largest text/software keyboard/dialog dismissal/focus return. Name iOS VoiceOver, Android TalkBack and browser spoken sessions separately. For calendars attach subscribed client/account type, stable UID/SEQUENCE update/refresh timings, duplicates, rotation/revocation/server status and remote cache/removal. Never attach the bearer URL.

For email attach approved sender/domain/DNS/secret resource identities, recipient consent/test scope, provider IDs/receipts, authenticated correlated callbacks, duplicate/refused callbacks, suppression, ambiguous reconciliation and approved cleanup. Provider acceptance is not inbox/read evidence. For migration attach approved mapping/private checksum, orphan/DST/timezone review, interruption/resume/replay/access/rollback reconciliation and authorization boundaries. For monitoring attach policy IDs, actual test alerts/ack/escalation/recovery timestamps. For pilot attach partners/exposure increments/metrics, rollback exercise and separate rollout approval.

## Recovery and acceptance limits

- Failure/stop condition encountered and preserved attempt:
- Authorized recovery action, accountable operator/date and evidence:
- Configuration or artifact changes that invalidate prior results:
- Retest scope and new run identity:
- Owner acceptance statement and explicit limitations:

Only the named decision owner may accept a gate. A filled record with missing evidence, failed thresholds or an unreviewed candidate remains pending/rejected. Update the runbook ledger and plan with the accepted scope; acceptance of one gate does not authorize launch or another external action.
