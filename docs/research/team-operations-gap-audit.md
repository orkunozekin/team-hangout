# Team operations: current implementation and roadmap gaps

Audited: 2026-10-12. Repository baseline: remote `main` at `a46a725`, the merge of PR #10. Comparison target: [competitor L](competitive-context.md#competitor-l-team-operations-with-game-following-and-media). This is a source and public-document review, not a deployed-app test. New recommendations below are **proposed, approval pending**; existing approved capabilities retain their approval. **Business model selection pending.**

## Findings

Most essential coordination capabilities are already approved in our plans but remain unimplemented. The immediate priority is completing the family and staff experience on top of the merged foundations. Matching isolated features does not establish usability, buyer demand or competitive superiority.

Organization administration and multiple guardians are already supported by the comparison target. Its official organization FAQ describes shared matchups and imports, warns that importing alongside another schedule publication path can duplicate events, lists baseball/softball/basketball/football/flag football organization support, and states that built-in bracket creation is unavailable. Soccer support in its team app is distinct from this organization list. These documented boundaries suggest opportunities worth validating, rather than proof that it cannot serve a particular buyer. [Organization scope](https://help.gc.com/hc/en-us/articles/44768057639949-Organizations-FAQ-s), [roles](https://help.gc.com/hc/en-us/articles/42602635189901-Team-Roles).

## What is actually in main

| Layer | Source-confirmed implementation | Exposure limitation |
| --- | --- | --- |
| Native baseline | Authentication, password-reset request, teams, invitation codes, basic match/practice events and focused single-team screens. | No household calendar or browser administration application. Native event types remain `practice` and `match`. |
| Authority | Server-owned team/event commands, scoped organization/program/season/division operations, revision checks and authorization rules. | Server support does not establish a usable organization-admin interface or deployed rollout. |
| Migration | Reviewed-manifest tooling, deterministic identity/time conversion and synthetic reconciliation procedures. | No live migration inferred from tooling or checked-in fixtures. |
| Participants and guardians | Independent organization-local participants, private profiles, guardian approval/revocation, roster enrollment and live-authorized discovery/profile callables. | Household reads remain feature-gated; no participant/guardian management screens or invitation lifecycle yet. |
| Deletion | Deny-first, resumable account cleanup, durable tombstones and recovery handling. | PR #10 is merged. Retention and live rollout policies remain gates. |

Code anchors: [native models](../../src/types/models.ts), [screens](../../src/screens), [Functions exports](../../functions/src/index.ts), [organization commands](../../functions/src/organizations/commands.ts), [participant commands](../../functions/src/participants/commands.ts), [participant policy](../../functions/src/participants/policy.ts), [migration](../../functions/src/migrations/legacy.ts), [deletion](../../functions/src/accounts/deletion.ts). Operational boundaries: [participant contracts](../participant-boundaries.md), [deletion contracts](../account-deletion.md).

The actual merge history establishes Phase 1 Steps 1–6 as merged. Its prior Handoff still described Step 6 as awaiting merge; that is a documentation lag, not evidence that deletion is absent. Steps 7–15 are incomplete; Phases 2–4 are planned. This audit does not rerun application tests or certify deployment. Historical baseline observations and test results in the plans retain their original dates.

## Review evidence and how it changes priorities

The [review profile](competitive-context.md#competitor-l-team-operations-with-game-following-and-media) records praise, complaints and limitations with direct source links. It is a convenience sample of public U.S. store reviews, not a representative measurement. Duplicate platform/page copies are one report; missing years and relative dates prevent confident age comparisons. A support response is not proof that a reported defect is fixed. Review-reported prices are not current official pricing.

The requests map to different categories: household convenience and remote following are adoption signals; attendance and snack coordination reinforce existing approved work; account/update problems suggest additional release tests; widgets and video purchases concern optional or deferred areas. A request for attendance does not justify automatically turning a missed check-in into an absence or assigning playing time by an algorithm.

## Approved coverage that is still missing from the implementation

Step references below are within the linked phase plans. These are existing approved tasks, not new approvals or claims of completion.

| Capability | Main today | Approved implementation owner |
| --- | --- | --- |
| Browser organization administration | Backend only | [Phase 1](../features/phase-1-foundations-feature-plan.md), Step 7. |
| Household UI, multiple-child views and invitations | Identity/grant backend only | Phase 1 Steps 8–10; revocable subscriptions Step 11. |
| Roster/schedule CSV preview and commit | Legacy migration tooling is distinct from user imports | Phase 1 Steps 12–13. |
| Essential app-free email | Not implemented; deletion cleanup hooks do not provide delivery | Phase 1 Step 14. |
| Shared-match mobile views, recurrence, scheduling and closures | Canonical server validation exists; operational UI/solver absent | [Phase 2](../features/phase-2-league-operations-feature-plan.md), P2.02–P2.08. |
| RSVP and actual attendance | Not implemented; guardian `respond` is refused in Phase 1 | Phase 2 P2.09–P2.11. |
| Reliable messaging, announcements, push/email and history | Not implemented | Phase 2 P2.13–P2.19. |
| Saved lineups, measured playing time and competition results | Not implemented | [Phase 3](../features/phase-3-coaching-competition-feature-plan.md), Steps 2–7. |
| Snack/setup/scorekeeping volunteers and rides | Not implemented | Phase 3 Steps 8–9, with a separate transport-policy gate. |
| Operational reports, exports and season rollover | Not implemented | Phase 3 Steps 10–12. |
| Registration and finance | Not implemented | [Phase 4](../features/phase-4-registration-finance-feature-plan.md); companion imports first, live charges gated. |

## Proposed additions or clarifications

These are audit recommendations, **not approved additions to the numbered implementation sequence**. Approval should be recorded and affected steps split or extended explicitly before implementation. The existing one-step-per-PR workflow continues to apply.

| Priority | Gap in current plans | Suggested owner and implementation boundary | Evidence needed |
| --- | --- | --- | --- |
| High | Bulk participant RSVP across several events is not specified; the planned API changes one event/participant at a time. The comparison target advertises multi-event responses. | Extend Phase 2 P2.09 or add a separate bounded step. Preview each selected participant/event and response; reauthorize each row, preserve revisions and deduplicate retries. Return per-row success/conflict; do not promise an atomic cross-organization bulk update. | Two guardians racing, mixed access, rescheduled events, partial failures and accessible selection UI. [Advertised behavior](https://www.gc.com/app-features/team-management). |
| High | Community events beyond practice/match lack a concrete type/validation contract. | Phase 1 calendar/import contracts and Phase 2 event service. Add a controlled general-event type with label and configurable RSVP/attendance eligibility for meetings, picture days, orientations and awards. These must not enter competition scores or facility reports as games. | Native/server serializers, CSV compatibility, filters and legacy readers tested; general events excluded from sporting calculations. The comparison target explicitly advertises non-game events. [Coordination scope](https://www.gc.com/app-features/team-management). |
| High | Read/ack timestamps and staff delivery diagnostics are planned, but a staff-facing recipient list and its access/retention policy are underspecified. | Clarify Phase 2 P2.13/P2.15/P2.16. For critical updates, show authorized recipients as acknowledged/not acknowledged/unreachable at the current revision; restrict individual read metadata, distinguish accounts from children, and avoid general chat surveillance by default. | Multi-child deduplication, guardian revocation, changed closure revisions and server-authorized pagination. Opening a push must not imply reading its source. |
| High | Password-reset request exists; a complete email-link-to-new-password-to-login native/browser rehearsal is not explicit in the phase acceptance steps. | Add to Phase 1 Step 7/9/15 acceptance, without assuming a new auth mechanism is necessary. Include the current externally handled reset flow, expired/used links, installed-app routing and account switching. | Real emulator/staging mail-action flow and both native platforms; source-only request tests cannot establish the full loop. [Existing request screen](../../src/screens/ForgotPasswordScreen.tsx), [existing auth adapter](../../src/api/auth.ts). |
| High | Compatibility and pilot tests exist, but a repeatable installed-app upgrade smoke suite is not a named release gate. | Phase 1 Step 15 and Phase 2 P2.20. Test upgrade with persisted auth/team selection, legacy and migrated records, invitations and denied/revoked access; add phased rollout monitoring and an update-required/recovery path. Preserve deliberate security cutovers. | Actual old/new binary rehearsal on iOS/Android with synthetic data; no restoration of unsafe legacy permissions to keep old clients working. |
| Medium | Competition scorers and volunteer scorekeeping are mentioned, but delegation scope/expiry/revocation and the granting UI are not concrete. | Clarify Phase 3 Steps 1/5/8 with a named event/team-scoped scoring grant. A volunteer assignment alone must not grant authority; scorekeepers cannot change rosters, grants, private notes or billing. | Expired/revoked grant, wrong event/org, correction authority and concurrent scorer fixtures. The comparison target distinguishes delegated scorers from full staff. [Role scope](https://help.gc.com/hc/en-us/articles/42602635189901-Team-Roles). |
| Medium | External IDs prevent many duplicate imports, but coexistence of manual imports and a later live integration lacks an explicit schedule-authority policy. | Clarify Phase 1 Step 13 and Phase 4 P4.18: source system/ID lineage, one authoritative ingestion path per scope, reviewed conflicts and switching paths. Similar names/time are not sufficient identity. | Same fixture received from two paths, moved venue/time, source correction, deletion and replay; retain canonical event identity. |

## Optional differences and intentional deferrals

- A private supporter role for approved relatives could expose a restricted schedule/results view without guardian RSVP, practice logistics, chat, contacts or child-profile access. This is not currently planned. Keep it optional and subject to a youth privacy/sharing decision; do not introduce a public child directory. The comparison target explicitly separates secondary relatives from primary guardians. [Relationship roles](https://help.gc.com/hc/en-us/articles/42602635189901-Team-Roles).
- Website schedule/score embeds and native widgets are absent. Consider only after secure calendar and results workflows are dependable. Public sharing needs a sanitized publication model and revocation policy; a calendar bearer URL is not a public embed API. The comparison target advertises website embeds. [Sharing features](https://www.gc.com/app-features/team-management).
- Streaming, replay clips, advanced player statistics and AI recaps remain deferred in our approved roadmap. A competitor's media offering does not approve that cost/scope for this product. Basic final-score publication and standings are already planned; live play-by-play is a separate, unapproved capability.
- Preserve safe season rollover. Returning-family convenience can use a reviewed re-enrollment/invitation campaign; never silently copy revoked permissions, waivers or obligations. Our Phase 3/4 plans already require this separation; the one-click continuity UX is not specified.

## Recommended order

Continue Phase 1 Step 7 rather than diverting into media parity. Before its later calendar/import steps, resolve the general-event and recovery-test proposals. Before Phase 2 RSVP/communications, decide bulk-response and critical-recipient reporting requirements. Scope scorekeeper delegation when Phase 3 competition starts. Validate optional spectator/public-sharing demand with actual community-center partners.

No pricing, new branding, feature approval, production deployment or claim of comparative reliability follows from this audit. Application implementation remains a separate explicit request.
