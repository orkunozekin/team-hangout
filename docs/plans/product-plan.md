# Team Hangout product plan

Recorded: 2026-10-10. Status: **Product direction and feature recommendations approved. Business model selection pending.**

## Purpose and decision status

Build a multi-sport league and team management experience for municipal parks and recreation departments, community centers, and independent clubs. Administrators, coaches, captains, players, and guardians share consistent schedules, rosters, attendance, and communication through views appropriate to their responsibilities. Support both youth and adult leagues, initially emphasizing soccer, basketball, and football.

The owner approved the recommendations and their phased prioritization. Approval means permission to plan and implement these capabilities in future feature work; it does not mean that they are already implemented or that every phase belongs in the initial release. Commercial options remain proposals, including who pays, packaging, pricing, transaction charges, advertising, and paid add-ons. No new branding decision is made here.

Read the linked [competitive research context](../research/competitive-context.md) for anonymized profiles, review evidence, pricing benchmarks, and research limitations. Observations in that document support this direction but do not establish buyer demand or willingness to pay.

## Current foundation and compatibility

Baseline inspected: repository main at commit `4541943`, on 2026-10-10. The app currently implements native authentication, team creation and invitation codes, coach/player memberships, practice and match scheduling, event filters and sorting, platform administrator access, account deletion, and configurable legal/support links. This is a source inspection, not confirmation of production deployment or store approval.

The current model has teams, memberships tied to login accounts, one selected active-team context, and team events. It does not yet represent organizations, divisions, households, independent participant records, guardian relationships, RSVPs, attendance, or messaging. Platform administrator access must not substitute for organization-scoped administration.

This plan supersedes the original out-of-scope row in [the scaffolding decisions](../../QUESTIONS.md) for RSVP, check-in, chat, payments, web administration, and notifications. Those become future roadmap work in the phases below. Other existing behavior remains the starting point until a feature-specific migration changes it.

Carry forward the successful RSVP, scheduling, check-in, and visual lineup behaviors from the owner's existing soccer app. Adapt their rules to league and household use rather than copying assumptions that every player has a login or personally submits their RSVP. Reuse concepts and verified logic where appropriate; do not connect development work to live data or presume the two apps share accounts or storage.

## Approved product structure

| Audience | Primary experience |
| --- | --- |
| Organization administrator | Manage programs and staff, coordinate facilities, publish schedules, resolve exceptions, and review participation across authorized teams. |
| Coach or captain | Manage assigned rosters and events, see availability, communicate, check attendance, and prepare lineups. |
| Guardian | Manage linked children, receive relevant updates, and respond for each participant using a separate personal login. |
| Player | View relevant events and updates, respond where permitted, and participate with minimal administration. |

One account can hold several roles across teams and organizations. A participant can exist without a login. Multiple authorized guardians can act for the same child without sharing credentials. Household views can aggregate relevant events across organizations without exposing one organization's private information to another.

Use one shared multi-tenant application with organization identity inside it. Provide native daily workflows and a web workspace for bulk administration. Separate administrative complexity from the quick actions families and coaches need.

## Delivery phases and acceptance criteria

Detailed implementation plans, their shared dependencies, and the feasibility evidence register are indexed in [phase implementation plans](phase-plans.md). Each numbered implementation step is intended to produce one scoped PR; approving the roadmap does not claim the proposed capabilities already work.

### Phase 1: Organization, household, and season foundations

Approved capabilities:

- Organizations, seasons, sports, leagues/programs, divisions, teams, and scoped staff assignments. Preserve access to prior seasons without cluttering the current one.
- Participant profiles independent of authentication, multiple guardian relationships, and clearly identified roles. Support coach/parent and captain/player combinations.
- Household calendars spanning children and teams, with participant/team/event-type filters and calendar subscriptions with clear subscription removal instructions.
- Guided invitations and onboarding, invitation status, roster and schedule imports, import previews, duplicate detection, and actionable row-level errors.
- Accessible navigation, screen-reader support, large text, clear language, and essential updates available through email for people without the app.

Acceptance scenarios:

- A parent coaching one team and managing two children on other teams uses one account, sees the correct calendar, and always knows whose RSVP or profile they are editing.
- Two separately authenticated guardians access the same child; unauthorized adults cannot link themselves or see private records. Organization staff cannot read another organization's data.
- A roster import with duplicates and invalid rows produces a reviewable preview and does not silently create duplicate participants or send invitations before confirmation.
- Existing teams, events, and invitations remain usable after migration. Existing membership data is preserved, with explicit organization association instead of guessed ownership.
- Core navigation and event actions work with a screen reader and enlarged text. Calendar subscription scope and unsubscribe instructions are understandable.

### Phase 2: Dependable league and game-day operations

Approved capabilities:

- Automatic league scheduling against facility availability, blackout dates, team and coach conflicts, and division requirements. Administrators review a draft and unresolved conflicts before publication.
- Recurring practices, bulk schedule edits, explicit cancellation/postponement, makeup scheduling, and facility closures that identify affected events and recipients.
- A concise agenda showing participant, team, RSVP status, opponent, home/away designation, arrival and start times, exact field/court, map location, parking, and uniform instructions.
- RSVP responses and reminders to nonresponders, late-arrival notes, coach attendance, and actual check-in recorded separately from intended attendance. Retain attendance history after events close.
- Location-assisted or simple participant check-in where appropriate, with an authorized manual fallback for denied permissions, poor signal, or no device. A missing device check-in must not automatically prove absence.
- Targeted organization/division/team announcements, pinned information, team and event conversations, reactions, attachments, message correction, and searchable history.
- Reliable push/email routing, notification links to the relevant content, meaningful acknowledgment for critical changes, and clear delivery/read/acknowledgment distinctions. Delivery reports must not imply guaranteed device receipt.
- Guardian-visible youth communication, appropriate messaging permissions, and private staff notes separated from team-visible content.

Acceptance scenarios:

- Publishing a schedule updates the relevant family and team views consistently. Drafts do not notify families; unresolved conflicts remain visible rather than silently disappearing.
- Closing a shared facility identifies all affected teams, supports postponement and makeups, and sends targeted updates without duplicate notifications from retries.
- A notification opens the specific message or event, including after authentication. Counts and content agree; failed delivery is visible to authorized staff and can be retried appropriately.
- A coach sees yes/no/unanswered availability on the agenda, then records actual attendance independently. Guardian edits identify the affected child and are reflected for other authorized viewers.
- Coaches can consult the last available game-day information during weak connectivity, see that it may be stale, and receive confirmation or an actionable error for attempted writes.
- Event history survives rescheduling and season archiving; cancellation does not masquerade as participant absence.

### Phase 3: Coaching, competition, and program insight

Approved capabilities:

- Sport-specific pitch/court views, saved lineups, substitutions, playing-time tracking, and coach-only planning where appropriate.
- Scores, standings, brackets, configurable competition rules, and authorized corrections.
- Volunteer assignments for snacks, setup, scorekeeping, and ride coordination, with appropriate contact visibility.
- Attendance trends, facility utilization, season rollover, and exportable operational reports.
- Age-appropriate practice templates and drill resources to help volunteer coaches.

Acceptance scenarios:

- Lineups preserve positions and ordering after save/reload and respect the selected sport; private coaching notes are not exposed to households.
- Score corrections update standings using the configured rules; authorized staff can trace changes.
- Volunteer slots display ownership and open needs without exposing private contact information by default.
- Reports distinguish RSVP from actual attendance and missing records. Season rollover preserves history without blindly copying obsolete permissions or guardian relationships.

### Phase 4: Registration and financial operations

Approved capabilities:

- Integrated registration, configurable forms, waivers, capacity limits, waitlists, scholarships, sibling discounts, payment plans, invoices, credits, and refunds.
- Youth individual enrollment and adult team/captain enrollment, with clear payment responsibility.
- Financial exports and integration paths appropriate to the organization's existing systems.

Start municipal adoption as a companion to existing registration systems, using reviewed imports first and verified integrations later. Offer private clubs the same operational core, with full registration as a later expansion. Do not replace broader facility memberships, front-desk sales, or city finance systems as part of the initial product.

Acceptance scenarios:

- Capacity, waitlist promotion, discounts, waivers, and payment plans work together without duplicate enrollment or charges.
- Registration fees, any platform fees, processing costs, credits, and refund outcomes are clear before commitment. Retried payment events do not duplicate financial actions.
- Reconciliation and exports explain differences between collected funds, refunded amounts, processing costs, and organization proceeds.
- Commercial packaging and payment-provider decisions are resolved before enabling charges. Feature approval does not approve a fee or a monetization model.

### Deferred capabilities

Livestreaming, a public social feed, advanced individual player analytics, and AI recaps are deferred. They are not prerequisites for adoption or committed launch features. Revisit only after the operational workflows show sustained use and buyers demonstrate demand.

## Business model selection pending

**No business model or price has been selected.** The research-stage preference is an organization subscription with optional payment revenue and essential household access included, but that preference is not a commercial approval.

| Option | Potential fit | Decision to validate |
| --- | --- | --- |
| Annual organization subscription | Municipal programs, centers, and established clubs | Budget owner, capacity bands, renewal timing, support entitlement, and procurement fit. |
| Per-team, per-season pricing | Smaller clubs and seasonal leagues | Seasonal affordability versus cost accumulation across teams. |
| Transaction revenue | Organizations adopting integrated registration | Achievable payment volume, processing costs, refund obligations, and fee acceptance. |
| Subscription plus optional payments | Serving companion and full-platform customers | Transparent separation of software and transaction charges; value without payment migration. |
| Service and branding add-ons | Larger organizations | Paid migration, integrations, support, and branding that do not require unsustainable custom development. |
| Family subscriptions or advertising | Consumer-led distribution | Adoption and trust risks, especially when a league requires use; neither is approved. |

Unvalidated annual price hypotheses from the initial research:

- Small club or community-center program: $750–$1,500.
- Multiple leagues or locations: $2,500–$5,000, with explicit capacity and support limits.
- Large departments or complex integrations: individually quoted after understanding requirements.

These are proposed research ranges in U.S. dollars, not competitor quotes, approved prices, or evidence of willingness to pay. The higher ranges need demonstrated operational value beyond lower-priced market entry points. See the research document for the separately sourced benchmarks.

Illustrative arithmetic only: 40 organizations at $2,500 annually produce $100,000 in annual subscription revenue before costs. A hypothetical 1% platform fee on $500,000 processed produces $5,000 before applicable costs. Payment volume is not revenue, and neither example forecasts profit.

Before selecting a model, validate budget authority, willingness to pay, procurement effort, seasonal retention, sales/onboarding/support cost, hosting and message cost, payment economics, and the limits of included service. Keep the organization-funded, ad-free household experience as a recommendation to test, not a settled packaging rule.

## Validation and implementation handoff

Run one-season pilots with a community center and a private club. Measure scheduling and rescheduling time, household activation, second-guardian onboarding, RSVP completion, attendance accuracy, critical-update acknowledgment, support demand, and willingness to renew at a stated price. Establish baselines and agree measurable targets with pilot partners before launch; do not claim success from downloads alone.

Deliver feature-specific implementation plans in phase order. Define migrations, authorization rules, synchronization behavior, notification retries, and operational ownership before coding each feature. Verify cross-organization isolation, multi-role households, concurrent edits, denied permissions, and low-connectivity behavior with meaningful tests. Use representative imported data without production credentials or real participant information in development.

Review the exact versioned SDK 54 documentation required by the repository before future application changes. This document changes product scope only; it does not implement screens, deploy services, migrate data, enable billing, or change the current architecture by itself.
