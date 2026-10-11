# Phase 4: Registration and financial operations

## Status

Recorded: 2026-10-10. Status: **planned, implementation not started**. Product capabilities are approved. **Business model selection pending. Payment provider, merchant arrangement, commercial fees and live payment activation pending.** No application changes or financial transactions are performed by this plan.

Parent: [product plan](../plans/product-plan.md). Execution and executed baseline: [phase plans](../plans/phase-plans.md). Dependencies: [Phase 1 foundations](phase-1-foundations-feature-plan.md), [Phase 2 operations](phase-2-league-operations-feature-plan.md), and relevant [Phase 3 rollover/report contracts](phase-3-coaching-competition-feature-plan.md). Competitive observations remain in [anonymized research](../research/competitive-context.md); the designs here are recommendations rather than competitor observations.

Implement exactly one numbered step per explicit invocation. Each step produces its own PR with validation, native/web UI captures when applicable, and the repository's AI review loop. Update Handoff after each step. Planning approval does not waive any activation gate.

## Goals and boundaries

- Let municipal programs continue using their registration/finance systems through reviewed imports and scoped exports before considering verified integrations.
- Offer configurable youth individual and adult team enrollment without confusing participants, guardians, captains or payers.
- Prove capacity, waitlists, waiver versions and fee calculations before connecting payments.
- Maintain auditable invoices, credits, installments, refunds and reconciliation; show clear obligations without storing payment credentials.
- Keep organization-funded software pricing separate from program registration charges. Do not implement a platform transaction fee by assumption.
- Start with one organization currency and a reviewed jurisdiction. Currency conversion, general accounting, city memberships, front-desk sales, payroll, lending, public fund custody and replacement of municipal finance systems are outside this phase.
- Registration is not a public child directory. Sensitive assistance applications, legal evidence and payment records remain separate from operational team rosters.

## Current state and feasibility evidence

Baseline inspected: `d66e89b`, 2026-10-10. Existing [models](../../src/types/models.ts) represent teams, authenticated memberships and events; they have no registration, waiver, capacity, invoice, money, payment or refund model. [Client dependencies](../../package.json) contain neither a payment SDK nor a registration form engine. [Server entrypoint](../../functions/src/index.ts) contains account deletion, not a payment backend. [Server configuration](../../functions/package.json) targets Node 22. The proposed paths and functions below do not exist yet.

Executed checks are the shared index's 93 existing client tests, client typecheck and compile-only server check with the stated Node-version limitation. Those checks are not financial, rules, load, browser-return or payment-provider proof. No sandbox checkout, registration concurrency probe, waiver validation or live transaction was executed during planning.

### Verified reference register

The following official URLs were opened on 2026-10-10. Living documentation must be rechecked before implementation; the SDK links are versioned. API references establish mechanisms and constraints only. Technical provider references below are examples for evaluating an adapter, not a provider selection or competitive endorsement.

| ID | Authoritative reference | Supports | Limit |
| --- | --- | --- | --- |
| F1 | [SDK 54](https://docs.expo.dev/versions/v54.0.0/) and [browser module](https://docs.expo.dev/versions/v54.0.0/sdk/webbrowser/) | Native browser handoff primitives and required platform baseline. | A complete checkout callback, authentication recovery and store approval need testing. |
| F2 | [Atomic transactions](https://firebase.google.com/docs/firestore/manage-data/transactions) | Atomic dependent writes and automatic transaction retries. | No atomic commit across database and payment service; callbacks must contain no external side effects. |
| F3 | [Payment API idempotency](https://docs.stripe.com/api/idempotent_requests) | One reference provider supports keyed retry semantics. | Key retention and account scope vary; durable application deduplication is still necessary. |
| F4 | [Webhook delivery](https://docs.stripe.com/webhooks) | Signature verification, retry handling and unordered event considerations. | Exactly-once delivery is not promised; selected adapter must prove equivalent behavior. |
| F5 | [Refund lifecycle](https://docs.stripe.com/refunds) | Refunds may remain pending or fail and need reconciliation. | Money returned cannot be inferred from request submission. |
| F6 | [Separate charges and transfers](https://docs.stripe.com/connect/separate-charges-and-transfers) | Merchant/funds-flow architecture affects responsibility and settlement. | A technical pattern is not authorization to hold public funds or adopt this arrangement. |
| F7 | [Store review rules](https://developer.apple.com/app-store/review/guidelines/#goods-and-services-outside-of-the-app) and [store payment policy](https://support.google.com/googleplay/android-developer/answer/9858738) | Physical services and digital functionality need different payment-policy analysis. | Regional and policy changes matter; these links do not preapprove the proposed app or digital subscriptions. |
| F8 | [Current child privacy rule](https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-312) | Child-directed collection needs an explicit applicability and consent review. | Guardian login alone does not settle compliance or all state/local requirements. |
| F9 | [Electronic signatures statute](https://www.govinfo.gov/content/pkg/USCODE-2024-title15/html/USCODE-2024-title15-chap96-subchapI-sec7001.htm) | Electronic records/signatures have a statutory framework. | Does not establish enforceability of a particular youth waiver or replace legal review. |

### Capability proof matrix

| Implementation piece | Present evidence | Required proof before release |
| --- | --- | --- |
| Companion registration imports | Phase 1 reviewed-import design; source-confirmed missing registration schema. | Synthetic source file preview, duplicate/replay, revoked operator and failed-batch tests; partner confirms mapping. |
| Form builder and immutable submissions | Documentation-supported database persistence; proposed domain design. | Shared pure schema/visibility validation; native/web accessibility captures; server rejects hidden-field injection. |
| Waivers and consent | F8/F9 applicability context; external decision. | Approved document/version/signatory policy; immutable evidence export and revoked-guardian tests. No claim of legal sufficiency from a checkbox. |
| Capacity and waitlists | F2 atomic mechanism; unexecuted spike. | Concurrent last-seat allocation, hold expiry versus payment, deterministic FIFO promotion and retry probes. |
| Discounts/scholarships | Proposed integer-money reducers and scoped grants. | Hand-calculated corpus and randomized invariant tests, budget concurrency, assistance-data isolation. |
| Youth/adult responsibility | Phase 1 participant/guardian/staff identity proposal. | Two guardians, captain replacement, captain-as-player and unauthorized payer-access scenarios. |
| Invoices/ledger/credits | Proposed append-only journal and immutable invoice versions. | Balanced journal replay, duplicate command, concurrent credit application and reversal tests. |
| Hosted checkout/provider adapter | F1/F3/F4 mechanisms; external enablement. | Selected sandbox adapter passes success, decline, pending, browser loss, signature and duplicate/out-of-order event matrix. |
| Installments | Proposed due-item/attempt contract. | Due-job replay, changed consent, failed installments, notices and cancellation tests with fake clock/provider. |
| Refunds/disputes | F5 lifecycle context; provider-specific capabilities pending. | Partial/duplicate/failed refund, over-refund races and dispute reconciliation in sandbox. |
| Reconciliation/exports | Proposed accounting reducers and Phase 3 export mechanics. | Hand-calculated settlement fixtures, missing fee/payout detection, formula-safe CSV and partner import acceptance. |
| Integrations | Import-first direction approved; target systems unknown. | Partner-provided documented API/sandbox/credentials/scopes and contract tests. No universal connector promise. |

Every row is viable as a bounded engineering hypothesis. Only its explicit proof gate can establish integrated viability. If a spike fails, retain companion/import mode and record the revised design instead of enabling a partially proven financial workflow.

## Shared contracts and dependencies

- Phase 1 owns `/organizations/{orgId}/members/{uid}`, organization-local `/organizations/{orgId}/participants/{participantId}`, active guardian links and `/teams/{teamId}/roster/{participantId}`. Participants need no Auth account. No cross-organization household ID is introduced.
- Guardian permissions are currently schedule/profile/respond permissions. Add explicit `registerParticipant` capability through the approved relationship flow; never infer waiver authority, payment authority or legal guardianship from `respond` alone.
- Adult self-linking must be approved; an email/name match is not proof of identity. Organization staff/captain role never grants unrestricted child profile or financial access.
- New registration subject is `{kind: individual,participantId}` or `{kind: adultTeam,teamApplicationId}`. Adult team applications are not automatically active teams or staff assignments.
- A payer is an explicitly accepted organization-local billing responsibility, distinct from roster membership and guardianship. A second guardian may see enrollment eligibility without seeing the first guardian's payment method or confidential assistance application.
- Use Phase 1 server commands with `{orgId,requestId,expectedRevision}` and payload-hash conflict detection, audited actor and immutable tenant references. Preserve the account-deleting gate. Use supported Firebase HttpsError transport codes with details.domainCode for STALE_REVISION, REQUEST_ID_REUSED and other domain outcomes; do not emit a nonexistent conflict transport code.
- Use Phase 2 durable outbox/notification status semantics for reminders and receipts. Financial truth does not depend on email delivery. Email contains minimal content and authenticated links, not waiver/assistance attachments.
- Phase 3 season rollover does not copy enrollments, payment obligations, assistance awards or executed waivers. Returning participants begin a reviewed new enrollment and sign the applicable new version.
- Canonical events retain nonempty `teamIds`, legacy `teamId = teamIds[0]`, UTC `startsAt`/`endsAt`, `timeZone`, independent `publicationState: staged|published`, lifecycle `status: scheduled|postponed|cancelled|completed` and monotonic `revision`. Registering does not mutate event identity; successful enrollment uses the existing roster command.

## Proposed data model

All organization paths below are under `organizations/{orgId}/`. These are new proposals, not existing collections. Store schema version, timestamps, actor/correlation and immutable scope references. Split documents by access rather than hiding private fields in a readable document. Server-only writes apply to capacity, awards, invoices, ledger, payment attempts and evidence.

| Path | Fields and invariants | Visibility |
| --- | --- | --- |
| `registrationOfferings/{offeringId}` | Program/season/division, individual/adultTeam mode, currency, open/close instants, timezone, eligibility policy version, form/waiver/price versions, capacity pool references, publication state/revision. | Published minimal summary to allowed applicants; staff draft separately. |
| `formVersions/{versionId}` | Immutable field IDs, supported types, required/visibility predicates, limits, labels, translations and privacy classifications. | Applicable applicant version; restricted private question definitions where needed. |
| `waiverVersions/{versionId}` | Immutable approved text/artifact hash, locale, signatory requirements, effective period, approval actor and downloadable artifact reference. | Applicants and approved legal staff; never editable after publication. |
| `registrations/{registrationId}` | Offering, subject reference, initiator, responsible billing party, form version, lifecycle and prerequisite states, revision. | Applicant/linked authorized adults get safe summary; staff by explicit capability. |
| `registrationResponses/{registrationId}` | Versioned validated answers; sensitive answers in further restricted documents. | Applicant editing scope and registration reviewers; coaches receive only roster-safe projections. |
| `waiverEvidence/{evidenceId}` | Registration/participant/version/hash, signer UID, relationship/authority snapshot, explicit affirmation, server acceptedAt, displayed locale, evidence hash. | Signer and approved legal reviewer; immutable, retention policy applied. |
| `adultTeamApplications/{applicationId}` | Captain UID, proposed name, offering, contact agreement, accepted billing responsibility, resulting teamId after acceptance. | Captain and registration staff; roster invitations separate. |
| `capacityPools/{poolId}` | Unit `participant|team`, limit, heldCount, allocatedCount, revision; optional explicit subgroup pools. | Staff totals and limited availability projection for applicants. |
| `capacityClaims/{claimId}` | Registration, pool, quantity, `held|allocated|released`, expiresAt, revision, release reason. | Own enrollment status; backend allocation authority. |
| `waitlistEntries/{entryId}` | Offering/pool, registration, server sequence, priority class/version, `waiting|offered|accepted|expired|withdrawn`, offer expiry/claim. | Own position/status with bounded privacy; staff ordered queue. |
| `priceVersions/{versionId}` | Currency, base/add-on items, discount stack/order/rounding rules, tax policy reference, refund policy, installment choices. | Applicant price disclosure and staff; immutable published version. |
| `quotes/{quoteId}` | Subject list, canonical inputs hash, price/discount/award versions, line amounts, expiry, capacity expectations, disclosure hash. | Explicit payer/applicant; no reusable authority after expiry or policy revision. |
| `discountRules/{ruleId}` | Version, fixed/percentage amount, verified eligibility, usage cap, stack/exclusion order, dates. | Public offer if intended; private eligibility server-side. |
| `assistanceApplications/{applicationId}` | Minimal requested evidence references, applicant, review state, approver; separate award amount. | Applicant and assistance reviewers only, not coaches or normal billing staff. |
| `assistanceAwards/{awardId}` | Participant/offering scope, currency, approved cap, reserved/applied/released amounts and expiry; no sensitive reason in invoice. | Payer receives approved amount; reviewers retain private reasoning. |
| `billingParties/{partyId}` | Explicit payer UID/authorized delegates, billing name/contact, organization scope and consent state. | Own payer/delegates and finance staff; no shared household payment identity. |
| `invoices/{invoiceId}` | Party, currency, immutable issued lines/version, due date, gross/adjustments/allocated receipts, derived balance, lifecycle. | Explicit billing party and finance capabilities. |
| `invoiceItems/{itemId}` | Invoice/registration, fee/discount/award/tax categorization, integer units/amount, immutable issue snapshot. | Same invoice authority; bounded pagination. |
| `ledgerJournals/{journalId}` and child `lines/{lineId}` | Immutable balanced debits/credits in one currency, effectiveAt, source operation/version, account codes and invoice/payment references. | Finance and authorized exports; never client-writable. |
| `creditBalances/{creditId}` | Party/currency, source credit note, remaining amount projection and version. | Own billing party and finance; consumed transactionally. |
| `paymentPlans/{planId}/installments/{itemId}` | Invoice, dueAt, amount, consent reference, `scheduled|due|processing|paid|failed|cancelled`, attempt pointer. | Payer and finance; no stored raw card details. |
| `paymentOperations/{operationId}` | Adapter/account/environment, kind, invoice, amount, currency, durable key, payload hash, remote reference, processing/unknown/final state. | Restricted finance projection; full operational record server-only. |
| `providerEvents/{eventKey}` | Environment/account/event identity, verified payload hash, receivedAt, durable processing state, remote object/version references. | Server only; raw payload retention bounded and redacted. |
| `refundRequests/{refundId}` | Original receipt, requested amount, reserved refundable amount, reason, approver, remote reference and lifecycle. | Payer safe outcome, finance full audit. |
| `reconciliationRuns/{runId}` | Provider account/environment, period, currency, source cutoff, totals, unresolved differences and export manifest. | Finance/report capability only. |
| `integrationConnections/{connectionId}` | System type, org scope, permissions, sync cursor, credential secret reference, active state. | Integration admins; secret values never client documents. |

Keep private health/accommodation responses out of general forms by default. Adding such collection requires a defined operational need, separate permissions and retention approval. Uploaded evidence uses Phase 2 private quarantine/scan/download authorization; this phase cannot bypass the attachment transport gate.

## Money, invoice and journal contracts

- Represent money as `{currency,amountMinor}` with integer values bounded below the JavaScript safe integer limit. Configure currency exponent explicitly; never assume every currency has two decimal places. First pilot supports one approved currency per organization with no conversion.
- Server owns pricing. Normalize quantities, eligibility and codes; reject negative/overflowing inputs. Client totals are previews only. A quote is accepted only if its version/hash, currency, subject list and expiry still match.
- Define percentage basis in integer basis points and one deterministic rounding policy. Example proposed policy: round half up per line after ordered discounts, then allocate residual cents deterministically by line ID. Validate buyer-specific tax requirements before activation.
- Sibling eligibility uses organization-verified participant relationships and eligible registrations, not just payer UID or matching surname. Adding/removing a sibling recomputes a new quote; no silent retroactive invoice rewrite.
- Apply mutually exclusive discounts first according to published priority, then permitted stackable discounts, then assistance. Cap reduction at eligible fee; taxes/add-ons follow explicitly approved rules. Reserve limited-use codes and award balances atomically with quote commitment.
- Issued invoices are immutable. Corrections produce a debit or credit note and new journal, retaining original lines/disclosures. Draft invoices may change with revision checks. A receipt is distinct from an invoice and a bank payout.
- Minimal journal account families: receivable, program revenue, restricted assistance/discount contra-revenue, provider clearing, bank settlement, processing expense, refundable liability and unapplied customer credit. Approve mapping with organization finance staff; this is a subledger, not a complete accounting system.
- Every posted journal balances per currency. Posting to a deterministic journal ID and recording its source-operation identity occur atomically. Corrections reverse/repost; never edit posted lines or delete financial history to fix a balance.
- Example fixture only, no approved fee: issue 10000 minor units → debit receivable 10000, credit program revenue 10000. Receive 10000 → debit provider clearing 10000, credit receivable 10000. Settle 9700 with 300 processing cost → debit bank 9700 and processing expense 300, credit provider clearing 10000. Taxes, platform fees and assistance require separately reviewed mappings.
- Credit balances are not refunds. Apply credit against an authorized invoice within the same organization/currency using an atomic reservation; race two applications in tests. Do not transfer credit between guardians, organizations or currencies automatically.
- An overpayment becomes unapplied credit pending payer-directed application/refund. Money owed, cash received, fees, refunds and net proceeds must remain separately visible. Provider-estimated fees are labeled estimates until settlement evidence arrives.

## Registration, capacity and waitlist lifecycle

Registration lifecycle: `draft → submitted → reviewing|waitlisted|offered|confirmed`; terminal `rejected|withdrawn|cancelled`. Track waiver/form/eligibility/financial readiness independently. `confirmed` requires a live allocated capacity claim and all offering prerequisites, not merely a successful browser redirect. Installment offerings may confirm after the approved initial amount, with remaining obligation explicit.

- The offering defines capacity unit: youth participant or adult team. Adult teams also have separate roster limits. Do not charge one team seat per roster player or allow one team seat to bypass safety roster limits.
- A server command reads all required pool counters, registration uniqueness locks, quote/award reservations and claim state in one transaction. It rejects oversubscription and writes the claim/counters/result together. All reads precede writes. Never call email or a payment API inside a retryable transaction.
- Uniqueness lock is deterministic for organization/offering/subject; sibling registrations have different participant locks. A second guardian opening the same enrollment gets the existing authorized summary, not another bill or leaked payment method.
- Initial hold duration is a configurable prototype hypothesis, not a guarantee. Server timestamps govern expiry. Delayed cleanup never grants extra capacity: allocation commands inspect expiry and release stale claims atomically or queue bounded cleanup before retry.
- Commit payment intent by first recording a durable payment operation tied to a capacity hold, then invoke the adapter outside the transaction. A remote timeout sets `unknown`; recover the same remote operation by durable key/reference before trying another charge.
- On confirmed payment, transactionally check hold validity and final prerequisites. If a hold expired, try reacquiring capacity under the same rules; if unavailable, do not oversubscribe or mark enrolled. Place the paid record in `paymentReceivedCapacityConflict`, block further collection, and follow a preapproved refund/credit resolution workflow visible to finance and payer.
- Never release a capacity hold on client timeout alone. A sweeper reconciles pending remote operations; if payment is still genuinely in flight, follow the adapter's supported cancellation/expiry contract. Expiry and webhook handlers contend on the same claim revision.
- Free/fully funded offerings use the same confirmation transaction without a remote payment. A zero-amount obligation must not create a charge request.
- Waitlist order uses server-issued monotonic sequence within the pool and approved priority class. Default FIFO is a recommendation. Organization preference/residency rules need explicit policy and validation; do not infer priority from private demographic data.
- Promotion is one serialized transaction: read earliest eligible waiting entry, capacity and active offer; create a timed hold and mark `offered`. Durable outbox sends the offer once per application operation. No seat promise depends on email receipt.
- Accept/reject/expiry is idempotent. Late acceptance after expiry cannot steal another offer's seat. Skips require a reason and audit. Changes to waitlist priority produce a reviewed preview rather than silent queue movement.
- Withdrawing enrollment releases future capacity only according to offering rules; it creates a separately tracked financial adjustment/refund request. Withdrawal and refunded are different states.

## Forms, waivers and responsibility

- Start with text, number, date, single/multiple choice, boolean and approved document acknowledgment. No arbitrary JavaScript/HTML, executable expressions or custom third-party scripts. Conditions reference earlier stable field IDs and use a bounded declarative predicate language.
- Compile published form versions into shared native/web validators plus authoritative server validation. Hidden fields are omitted or rejected, required conditional fields enforced, maximum lengths enforced, locale dates normalized. Client-only validation never authorizes a submission.
- Save drafts per applicant/registration with revision checks. Final submission freezes its version and snapshot. Later offering edits create a new version; staff can explicitly request updated answers without silently invalidating an executed waiver.
- Youth registration requires an active approved guardian relationship with registration/signature permission under the organization policy. Record signer identity and authority assertion; do not expose sibling sensitive answers to unrelated guardians.
- For adult team registration, the captain accepts team billing responsibility explicitly. Invite players separately; each adult signs their own required participant waiver. Captain agreement is not blanket consent for every adult or any child.
- Captain replacement requires accepted transfer of future billing authority and staff approval. Historical obligations/evidence retain original signers; changing captain does not silently move debt or payment methods.
- Waiver evidence includes the exact displayed immutable text/artifact hash, selected locale/version, participant, signer, affirmation, server receipt time and authority snapshot. Preserve a retrievable copy. Avoid collecting IP/device fingerprints by default; any additional evidence needs a justified retention policy.
- Typed names or checkbox affirmations may be technically captured but are not declared legally sufficient. Counsel/municipal legal owners must approve wording, signer rules, electronic delivery/consent, retention and accessibility before the waiver gate opens.
- Declining a required waiver blocks confirmation with clear support route; optional photo/media consent is separate and not preselected or bundled into participation consent.
- Account deletion revokes access/payment tokens and stops unauthorized future attempts while preserving required organization financial/legal evidence under an approved retention schedule, pseudonymizing unnecessary contact fields. Outstanding debt is not permission to prevent account deletion indefinitely.

## Provider-neutral payment and security design

### Adapter and activation decisions

Define a server-only `PaymentAdapter` with `createCheckout`, `retrievePayment`, `cancelPayment`, `createRefund`, `retrieveRefund`, `verifyWebhook`, `listSettlementActivity` and capability metadata. Each method declares support for partial refund, asynchronous methods, saved consent, installment attempts and event lookup. A fake deterministic adapter ships first. Unsupported capabilities remain disabled in UI and offering configuration.

Evaluate (1) organization-owned merchant accounts connected by scoped credentials, (2) platform-mediated connected accounts, and (3) external-registration companion mode with no payment custody. Compare public-funds procurement, settlement owner, liability, disputes, onboarding checks, supported countries/currencies, support burden and reconciliation exports. No option is selected here. Platform fees default to unavailable until the business decision and applicable funds flow are approved.

First real integration hypothesis is hosted checkout launched in a system browser, minimizing custom native credential handling. This still requires a successful SDK54/device/web-return spike and current store-policy assessment. A native payment sheet is a later adapter/UI choice if justified; it is not assumed installed or supported by the present Expo configuration. Never build card-entry fields or log raw account numbers/security codes.

### API boundaries and authorization

| Proposed command | Actor | Required server behavior |
| --- | --- | --- |
| `publishOffering` | Registration manager | Validate policy versions, capacity, form/waiver approval, currency and capability gates; expected revision. |
| `saveRegistrationDraft`, `submitRegistration` | Approved self/guardian/captain | Verify subject/relationship at action time; validate versioned answers; deduplicate subject. |
| `createRegistrationQuote`, `acceptQuote` | Applicant and explicit payer | Derive authoritative pricing; reserve eligibility/capacity; reject changed disclosure. |
| `approveAssistance`, `reserveAward` | Assistance reviewer/backend | Separate private review from award amount; atomic budget/cap checks. |
| `promoteWaitlist`, `acceptWaitlistOffer` | Scoped staff/applicant | Serialize queue/claim mutation; reject stale offer and unauthorized subject. |
| `issueInvoice`, `createCreditNote` | Finance manager | Immutable source lines and balanced journal; finance authority distinct from coach. |
| `startCheckout`, `getPaymentStatus` | Explicit payer | Require accepted responsibility, exact invoice and active environment/account; return safe projection only. |
| `acceptInstallmentPlan`, `cancelFutureAttempts` | Explicit payer/finance as policy allows | Store consent/version, schedule bounded due work; no retroactive card authorization. |
| `requestRefund`, `approveRefund` | Payer request/finance approval | Validate original receipt, refundable balance, reason and policy; reserve before remote request. |
| `runReconciliation`, `createFinancialExport` | Finance/report capability | Scoped period/currency, audit, pagination and safe download; no participant private answers. |
| `configureIntegration`, `previewExternalEnrollmentImport` | Integration manager | Secret reference and minimal scope; source mapping review and dry-run before commit. |

All commands recheck active account/tenant role and immutable ownership. Client cannot choose provider account, amount to charge, fee, paid status, scholarship approval or ledger account mapping. Use recent authentication for credential changes and sensitive finance actions; evaluate second-approver threshold as a partner decision before enabling high-value refunds. App attestation/rate limits supplement authorization rather than replacing it.

### Durable operation and webhook protocol

- Durable key scope includes environment, provider account, operation kind and internal operation ID. Store payload hash permanently according to retention policy; a changed payload with the same key is rejected. Selected adapter retention limits determine recovery procedures, not blind retries after expiration.
- Sequence: transaction records intent/reservations → worker calls adapter → transaction records remote reference/result → durable reconciliation handles unknown outcomes. An operation cannot issue a second remote mutation simply because its worker lease expired.
- Verify webhook signature against raw request bytes using the correct endpoint secret before accepting events. Enforce environment/account allowlists and size/rate limits. Never trust client-supplied success or return URL query parameters.
- Persist a verified event inbox record using `(environment,account,eventId)` uniqueness, then acknowledge promptly. A durable worker processes it with bounded retry/dead-letter state; duplicate delivery returns success without duplicate postings.
- Event arrival order cannot drive a simplistic last-write-wins status. Retrieve canonical remote payment/refund objects when needed and apply legal transitions; retain conflicts for reconciliation. Provider status adapters map to internal `created|requiresAction|processing|succeeded|failed|cancelled|unknown` without assuming all providers expose the same states.
- If webhook storage fails, return a retryable failure. If processing fails after durable receipt, the worker owns retry; alert on age/error budget. Reconcile missed events by provider lookup and settlement import.
- Browser completion/cancel shows “checking payment status” and polls the authorized internal record with backoff. Recover after app kill/sign-in. A cancel browser close does not prove remote cancellation. Deep links must target a known internal checkout operation, never arbitrary URLs.
- Separate test/live credentials, endpoint secrets, document/environment namespaces and explicit activation flags. No live key or merchant secret in mobile bundles, public config, logs or source. Record audit metadata without raw sensitive payment payloads.

## Installments, refunds and reconciliation

- Payment plans are finite installment schedules against an issued invoice, not platform software subscriptions. Store exact amounts/due instants, approved mandate/consent and cancellation rules. Sum installments equals the amount financed; no hidden rounding residual.
- Initially support invoice reminders and payer-initiated installments. Automatic off-session collection requires selected adapter capability, explicit suitable consent, authentication-recovery path and approved policies; it is a separate gated step.
- One due installment has at most one unresolved collection attempt. A scheduled worker marks processing transactionally, executes externally and reconciles unknown before retry. Failed payment creates clear due status/notices, never automatic absence or public roster labels.
- Revoking a payer's mandate stops future automated attempts but does not erase an invoice. Payment-plan delinquency and participation eligibility are separate policy decisions requiring organization approval and manual exception support.
- Refund states: `requested → approved → submitting → pending → succeeded|failed|unknown`; denied/cancelled only before an irreversible remote action. Reserve refundable amount in one transaction including other pending requests. Total succeeded plus reserved refunds cannot exceed eligible collected amount.
- Refund to original method where supported. Distinguish fee return, program refund, platform fee reversal and credit note. Do not promise processing fees return or organization net proceeds recover until adapter/contract evidence proves it.
- Partial refunds allocate to original invoice/receipt lines deterministically. Invoice obligation reduction and cash return are separate journals. If the remote refund fails, retain the obligation adjustment and refund liability pending approved resolution; do not fabricate cash movement.
- Handle disputes/chargebacks through event intake and manual finance workflow even if contesting them stays in the provider portal. Prevent an overlapping refund from refunding already-disputed funds without reconciliation. Record fees and reversed outcomes separately.
- Reconciliation compares internal receipts/refunds/clearing to remote transactions, fees and bank payout batches at a fixed cutoff per currency/account. Categorize timing differences, missing remote records, duplicate mappings, pending refunds, disputed funds, unavailable fees and unexplained differences.
- A reconciliation run is immutable and reproducible from recorded source references; corrections create a new run. Payouts can aggregate many registrations and cross date boundaries. Gross collection is never labeled net revenue or bank cash.
- Export invoices, adjustments, receipts, refunds, fees, awards and settlement references as separate or explicitly typed rows with stable IDs. Include currency, timezone/cutoff, schema version and mapping. Escape spreadsheet formula prefixes and protect downloads with short expiry and fresh authorization.
- Integrations start with reviewed CSV schemas. Later connectors require verified target API rights, sandbox, pagination/rate-limit strategy, stable external IDs, revocation and redacted error handling. Sync cursor advances only after durable batch commit; source corrections produce auditable diffs, not silent overwrites.

## Query, limits and migration strategy

- Add reviewed indexes for offerings by publication/window; registrations by offering/state/createdAt and payer/state; waitlist by pool/state/priority/sequence; claims by state/expiresAt; installments by state/dueAt; operations by state/updatedAt; refunds by receipt/state; journals by effectiveAt/source; reconciliation runs by account/period.
- Direct applicant reads use explicit authorized documents or server-projected paginated lists, not broad queries filtered on the client. Private assistance data never shares a readable invoice document. Verify rules emulator behavior and staging composite indexes independently.
- Initial engineering budgets are hypotheses: 25 rows/page, 50 lines/invoice, 20 subjects/quote, 100 import rows/batch, 10 concurrent remote calls/worker and 1,000 simulated competing registrations/load fixture. Measure contention/cost before changing limits; no production throughput promise.
- Capacity pools intentionally serialize scarce inventory; if contention fails the spike, design a queue/single-writer allocator before rollout. Sharded approximate counters cannot authorize scarce seats.
- Migration adds collections and opt-in organization flags; existing roster access remains operational. Import external registrations with deterministic source-system/external-ID locks and a reviewed participant mapping. Do not infer historical paid status, waiver validity or guardianship from a CSV name.
- External finance history is labeled imported with provenance and validated totals; do not reconstruct unsupported ledger detail as real provider activity. Keep imported balances in a clearly approved opening journal if finance accepts them.
- Payment flags cannot disable webhook intake, reconciliation or refund completion for money already accepted. Emergency stop prevents new checkout/automatic attempts while keeping status, receipts and finance recovery available.
- Backup/restore plan must reconcile external payment state before workers resume. Replaying restored operations cannot reissue old charges. Record operation high-water marks and tested recovery procedures.

## Numbered PR-sized implementation steps

Each step below is a bounded deliverable. Dependencies refer to numbered steps in this plan plus prerequisite phase contracts. Future tests listed here have not run during planning. Backend-only steps state UI evidence not applicable; every UI step captures the actual changed native/web checkout states with synthetic data and attaches reviewer-accessible images.

1. [ ] **P4.01 Lock domain and finance authority contracts.** Add pure registration/money/state types and separate registration, assistance, finance and integration capabilities; add deny-by-default rules and two-tenant fixtures. Define legal/business/provider decision records with pending status. Test immutable tenant IDs, guardian/captain/payer separation, safe integers and expected-revision deduplication. Exit: prerequisite schemas and authority tests pass; no live payment path. UI evidence not applicable.

2. [ ] **P4.02 Deliver companion import preview and mapping.** Depends on 1 and Phase 1 imports. Add external registration IDs, subject mapping and safe opening-status fields; preview duplicates, row errors and unsupported finance/waiver claims. Resume confirmed batches with stable IDs. Test replay, partial failure and revoked operator. Capture web preview/error/commit and native imported enrollment summary. Exit: operations usable without replacing municipal payments.

3. [ ] **P4.03 Publish offerings and validated form versions.** Depends on 1. Implement bounded declarative form compiler, server validators, immutable published versions and eligibility configuration. Native applicant/web admin screens show draft/published/version updates. Test conditional required fields, injected hidden answers, boundary dates and stale drafts; capture accessibility and enlarged text. Exit: server rejects invalid submissions independent of UI.

4. [ ] **P4.04 Capture versioned waiver evidence.** Depends on 3 and approved waiver/signatory/retention policy; private document transport must be proven before uploads. Add immutable version storage, explicit signer authority, separate optional consent and retrievable evidence. Test text hash/version, revoked guardian, adult self-signature and amended policy. Capture consent/decline/copy flow. Exit: owner-approved legal gate recorded; no claim that checkbox storage alone establishes enforceability.

5. [ ] **P4.05 Prove capacity allocation and expiry.** Depends on 1/3; backend prototype PR with no production enablement. Implement transaction-only pool/claim/uniqueness commands and fake-clock expiry. Race 1,000 synthetic attempts for a limited pool, two guardians for one participant and hold expiry versus confirmation; record latency/contention and invariant results. Exit: no oversubscription/double registration, bounded failure/retry. If failed, stop dependent seat work and redesign. UI evidence not applicable.

6. [ ] **P4.06 Deliver waitlist offers and acceptance.** Depends on 5 and Phase 2 outbox. Add deterministic order, reviewed priorities, promotion/expiry, staff reasoned skip and applicant acceptance. Test duplicate workers, simultaneous decline/promotion, late acceptance and unavailable notification. Capture queue, offer countdown, expiry and accessible alternate contact path. Exit: one seat maps to one active accepted claim.

7. [ ] **P4.07 Deliver deterministic pricing and sibling discounts.** Depends on 3/5. Implement versioned price reducers, server quotes, integer rounding, stack rules and capped code reservations. Test hand-calculated corpus, randomized total bounds and two-guardian/code cap races. Capture itemized quote/changed-price/expired states. Exit: displayed accepted disclosure equals committed invoice inputs; no platform fee assumed.

8. [ ] **P4.08 Deliver confidential assistance awards.** Depends on 7 and approved assistance-data policy. Add minimum-data application/review, explicit award budgets and atomic reservations/application/release. Test reviewer scope, coach denial, multiple registrations competing for one award and private reason exclusion from receipt/email. Capture applicant decision and private reviewer states with synthetic records. Exit: budget never overspent and unrelated household members cannot view evidence.

9. [ ] **P4.09 Implement invoices and balanced journal.** Depends on 7/8. Add immutable issue snapshots, financial authority, deterministic journal posting, debit/credit notes and replayable balances. Test issue/payment/fee/refund examples, duplicate source, corrections and safe-range overflow. No provider connection yet. Capture itemized invoice/balance/correction. Exit: all journal fixtures balance and projections rebuild exactly.

10. [ ] **P4.10 Implement credit allocation and payer permissions.** Depends on 9. Add explicit billing responsibility/delegates, unapplied credits and atomic application/reversal. Test simultaneous applications, cross-currency/org denial, two guardians and deleted/revoked payer. Capture credit versus cash refund labels and payer-delegate controls. Exit: no credit double spending and financial access is distinct from participant access.

11. [ ] **P4.11 Deliver adult team enrollment and captain transfer.** Depends on 4/5/9. Add team application capacity units, accepted captain payment responsibility, separately invited adult participants/waivers and resulting team creation via Phase 1 commands. Test captain/player dual role, roster limits, rejected transfer and preserved historical obligations. Capture team application, player prerequisites and accepted-transfer confirmation. Exit: captain never signs another adult's waiver implicitly.

12. [ ] **P4.12 Build fake payment adapter and durable orchestration.** Depends on 5/9/10. Implement operation intent, worker lease, fake provider, unknown-outcome recovery and verified-event inbox abstraction. Exercise timeout before/after remote commit, duplicate/reordered events and paid-capacity conflict with test clock. Exit: one financial posting per remote outcome, no remote calls inside database transactions. UI evidence not applicable unless adding a diagnostic screen.

13. [ ] **P4.13 Prove selected sandbox adapter and browser return.** Depends on 12 and explicit provider/merchant selection plus sandbox credentials; business model remains pending unless separately approved. Implement one hosted adapter, raw signature verification, sandbox checkout and SDK54 handoff. Capture real native/web success, authentication recovery, decline/pending, cancel and killed-app return using synthetic provider test data. Record account/environment verification and policy assessment. Exit: entire adapter matrix passes; live flag remains off.

14. [ ] **P4.14 Deliver payer-initiated installment plans.** Depends on 9/13. Add exact finite schedules/consent, due items, reminders, payer checkout and failed installment handling. Test residual cents, duplicate due jobs, changed payer, revoked consent and invoice cancellation. Capture schedule/due/failed/recovery states. Exit: partial payment status never falsely means fully paid; no automatic off-session charge yet.

15. [ ] **P4.15 Add gated automatic installment collection.** Depends on 14 and approved mandate/adapter support. Implement one unresolved attempt per item, due worker, authentication-required recovery and cancellation. Test failure/retry/unknown/revocation with sandbox/fake clock. Capture consent, revocation and action-required states. Exit: explicitly unsupported methods remain unavailable; no retries after mandate removal and no unapproved participation penalty.

16. [ ] **P4.16 Deliver credits, partial refunds and disputes workflow.** Depends on 10/13. Add request/approval, refundable reservation, remote lifecycle mapping, line allocation and dispute flags/manual disposition. Test overlapping partial refunds, failed/pending outcomes, fees not returned and account deletion. Capture pending/succeeded/failed outcomes with accurate cash-versus-credit language. Exit: total reserved/succeeded refund never exceeds eligible funds, original journal retained.

17. [ ] **P4.17 Deliver settlement reconciliation and financial exports.** Depends on 13/16. Add provider lookup/import, fixed-cutoff journal comparison, fee/payout matching, missingness and immutable run manifests. Use hand-calculated fixtures and selected sandbox settlement evidence where available. Test formula-safe CSV, scoped downloads, mixed currencies, timing differences and unresolved fees. Capture finance discrepancy/report/export states. Exit: gross, costs, refunds and proceeds reconcile or show explicit unresolved differences.

18. [ ] **P4.18 Prove one partner integration contract.** Depends on 2/17 and selected partner API/sandbox access. Produce minimal connector mapping, dry-run diff, stable external IDs, pagination/rate-limit/retry and secret revocation. Test source corrections, malformed batch and expired credential. Capture admin preview/error/recovery. Exit: partner validates resulting file/API records; absent API permission leaves companion imports supported and connector gated.

19. [ ] **P4.19 Run pre-live financial recovery rehearsal.** Depends on 13–17 as enabled and approved operational ownership. Rehearse new-payment stop, webhook downtime, restored database, stuck refund, retained legal evidence and payer deletion with synthetic data. Produce reconciliation/alert/runbook evidence, worst-case measured queue age/cost, staff training and support escalation. Capture applicant pending/support states where changed. Exit: no replayed charge; recovery responsibilities clear.

20. [ ] **P4.20 Complete activation decision and controlled pilot.** Depends on proven enabled workflows and external approvals below. Record business model, actual fees, merchant/procurement, legal/store policy, retention and incident owners; obtain explicit live enablement authorization. Start one bounded offering with agreed enrollment/financial targets and reconciliation review, preserving companion mode. Capture final disclosures and all supported native/web payment outcomes. Exit: pilot acceptance is measured, unresolved limitations disclosed, no unapproved fee or live activation.

## Files to touch and validation commands

Existing integration points: [client models](../../src/types/models.ts), [navigation entrypoint](../../App.tsx), [Firestore rules](../../firestore.rules), [indexes](../../firestore.indexes.json), [server entrypoint](../../functions/src/index.ts), [server package](../../functions/package.json), and [client package](../../package.json). Confirm actual sibling-phase directories after their PRs merge.

Proposed new modules, not existing links: shared `shared/registration/` and `shared/finance/`; server `functions/src/registration/`, `finance/`, `payments/`, `integrations/`; native `src/features/registration/` and `billing/`; web admin registration/finance areas in Phase 1's separate web workspace. Extend Phase 1’s `shared/` boundary rather than creating a second package structure. Separate pure reducers from provider/network adapters.

Run existing `yarn typecheck`, meaningful scoped client tests and server build under Node 22. Add explicit emulator-only authority/concurrency tests, pure reducer/property tests, fake-provider contract tests and selected sandbox contract tests as their steps introduce the harness. CI must fail if emulator tests lack explicit local hosts/project or accidentally select live credentials. Never use production participant data to validate this plan.

Native screenshots come from the actual simulator/device build for the PR checkout; hosted browser pages and web administration use browser captures as additional evidence. Inspect captures and fix visible issues, covering enlarged text, screen reader labels, loading, empty, failure, pending and retry states appropriate to the step. Do not attach real payment credentials or youth information.

## Release gates and acceptance

- [ ] Approved prerequisite identity/authority contracts and a cross-tenant/private financial data isolation suite exist.
- [ ] Registration, form and waiver versions remain immutable/auditable; required consent and separate optional consent work without inaccessible interactions.
- [ ] Capacity, duplicates, waitlist promotions and late payment conflicts pass concurrent tests and measured load budgets.
- [ ] Youth guardian, second guardian, adult captain, captain replacement, payer delegate and deletion scenarios preserve the correct responsibility boundaries.
- [ ] Discounts, awards, installments and credits have deterministic integer-money results; every posted journal balances and every projection rebuilds.
- [ ] Adapter duplicate/unordered/missing events, unknown outcomes, partial/failed refunds and disputes reconcile without duplicate charge/refund or false enrollment.
- [ ] Companion imports/exports work without requiring the organization to move payments or reveal unrelated participant information.
- [ ] Fees, tax applicability, refund policies, who pays and net proceeds are clear before commitment. **Business model selection pending** remains true until a separate recorded decision.
- [ ] Provider/account ownership, public-funds handling, procurement, credentials, settlement responsibility, store policy and live activation are explicitly approved before collecting money.
- [ ] Legal owners approve youth privacy, electronic consent/waivers, assistance-data scope and retention. These are external review gates, not legal conclusions supplied by this plan.
- [ ] Finance/support operators can stop new collections, recover jobs, reconcile discrepancies and complete existing obligations while enrollment is disabled.
- [ ] Pilot records enrollment completion/abandonment, double-enrollment/charge incidents, unresolved money differences, support load and partner export acceptance against agreed targets; downloads alone do not establish success.

## Handoff

### Done so far

- Inspected current models/dependencies/server entrypoint and predecessor contracts; mapped approved phase scope into bounded steps and explicit data/authority/state contracts.
- Opened the listed official references and separated documentation-supported mechanisms from unexecuted runtime/load/sandbox proof and external decisions.
- Recorded a companion-first fallback and provider-neutral design without selecting pricing, fees, merchant structure or live payment provider.

### Remaining work

Implementation is not started. On a future explicit implementation request, begin **P4.01 only** after Phase 1/2 contracts exist; do not implement the whole phase or enable payments. After each PR, update completed step, exact validation evidence, review status, unresolved gates and next incomplete step. Use `/handoff` as work progresses and `/feature-context` to resume this plan.

### Blockers and risks

Prerequisite schemas are still planned; capacity contention, device/browser return and provider sandbox behavior remain untested. Merchant procurement/provider selection, business model, actual fees, partner API rights, waiver/child-data/retention policy and live authorization require external decisions. These block their dependent implementation or release steps, not the useful companion-import work. No evidence in this document claims a future financial workflow has already passed its tests.

### Pointers for the next agent

Read the execution index and merged prerequisite plans. Preserve organization-local participant identity, canonical event IDs, scoped guardianship and durable operation semantics. Keep payment status, enrollment state, financial responsibility and actual bank settlement distinct. Prove each numbered step in its own PR, attach real UI evidence when relevant, address AI review feedback and leave merging to the user.
