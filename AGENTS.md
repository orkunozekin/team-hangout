# Expo SDK 54

This project uses Expo SDK 54. Read the exact versioned docs at https://docs.expo.dev/versions/v54.0.0/ before writing any code.

# Pull requests

- Create regular pull requests, not drafts, unless the user explicitly requests a draft.
- Deliver repository changes through a pull request targeting `main`. Use a `codex/` branch unless the user specifies another branch. Open the PR as part of completing the work; do not stop at a local commit or branch push. A direct push to `main` requires an explicit user instruction for that change.
- Keep PR titles and descriptions short and simple. No em dashes or hard-wrapped paragraphs.
- Include what changed, why, and relevant validation. Do not merge or enable auto-merge unless the user explicitly requests it.

# UI evidence

- Before opening a PR that changes screens, components, layout, styling, or user-visible interactions, run the affected UI and capture one representative screenshot by default, with at most two when a second state is essential. Summarize other states and interaction results through focused tests and concise text. Use a simulator or device for native UI and an appropriate browser capture tool for web UI. Verify that the running app belongs to the PR's checkout and includes its latest changes.
- During initial implementation, inspect screenshots, fix visible problems, and recapture before opening the PR. Use non-sensitive development data. Inspect the representative capture and validate other relevant interaction, loading, empty and error states with focused tests; do not create a screenshot for every state.
- After fixing UI in response to review feedback, do not recapture, replace, or add screenshots. Keep the initial PR screenshots and their original commit provenance. Validate the fixes with appropriate tests and describe the changes and validation in text; do not claim the original images show later fixes. This owner preference overrides skill instructions requiring screenshots after feedback fixes unless the user explicitly requests new captures.
- Include the screenshots in the PR description under **UI evidence**, with brief captions explaining the state and behavior shown. Upload attachments or use a repository-approved location accessible to reviewers and embed the images. Local filesystem paths alone do not count as PR evidence. Keep scratch captures out of source commits unless the repository adopts a committed-artifact convention.
- If the app cannot run, a state cannot be reached, or images cannot be attached, describe the exact blocker in the PR and final handoff and retain any local captures. Keep the PR open for review and clearly report the missing evidence. Do not claim visual verification without inspecting real captures.
- Documentation-only and other changes without a user-visible UI effect do not require screenshots; state that UI evidence is not applicable in the PR.

# AI review feedback loop

- For every PR, allow at most two total GitHub Codex bot review requests/runs, including the initial review: at most one re-review. Count automatic initial runs and failed/unavailable requests toward the cap. Batch valid fixes and meaningful validation before the second request. After the cap, send no further Codex review requests; accurately report remaining findings and any unmet current-head review gate. This repository-wide cap supersedes the earlier unlimited P2.02 re-review override and does not authorize merging unreviewed final changes or bypassing branch protections.

- The required AI reviewer for the current and remaining Phase 2 steps is the GitHub Codex review bot, requested with `@codex review` in a new top-level PR comment. This human-authorized policy replaces the previous Greptile 5/5 gate from 2026-10-15 onward; retain historical Greptile evidence without requiring a new numeric score.
- Require a completed Codex code review tied to the exact current PR head, every actionable finding fixed or explicitly dispositioned, passing relevant CI, original UI evidence with accurate provenance, and compliance with existing branch protections. Verify the actual bot identity and review commit. A setup/access/unavailable response, absent review, local Bugbot review or self-review does not satisfy this gate. Do not change branch protections to bypass a required check or approval.

- After opening a PR, check its checks, review summaries, conversation comments, and unresolved inline review threads. Wait for configured AI review checks to finish when available. Do not treat an absent review as approval; report a missing or unavailable reviewer explicitly.
- Use the local `address-pr-feedback` skill when available. Review AI feedback first, then human feedback. Fix valid in-scope issues, run appropriate validation, commit, and push. Explain feedback that is incorrect, obsolete, or outside scope instead of blindly implementing it. Ask the user when a material product or security decision is unresolved.
- Reply to addressed threads and resolve bot threads once fixed or intentionally declined with a reason. Do not resolve human threads without explicit user authorization.
- After fixes are pushed and the bot threads are addressed, and only if the Codex review cap permits another request, post a **new top-level PR comment** tagging each relevant AI review bot and briefly summarize the fixes or dispositions. Use the exact `@codex review` trigger for the required GitHub reviewer, identify the exact head SHA, and summarize the fixes or review focus. Verify other bots' mention handles from the PR or configuration. Do not use a PR description edit or an edit to an old comment as the re-review request.
- Wait for the requested re-review and address additional valid issues, without requesting another Codex review once the two-review cap is reached. Use bounded waits, avoid duplicate tags while a review is running, and report unavailable reviews or blockers rather than claiming completion.
- Preserve review-bot additions to the PR description. If screenshots or other requested content must be added later, fetch the latest description and preserve bot-owned sections verbatim.
- Before reporting the PR ready, refresh its state and confirm the completed GitHub Codex review is tied to the exact current head, relevant checks pass, all actionable findings are addressed or dispositioned, and initial UI evidence is attached with accurate provenance. Review feedback fixes do not require updated screenshots; report their changes and validation in text. Report any unresolved items and leave merging to the user.

# Code Review Rules

- Review the complete PR diff and every affected caller, adapter, existing screen and compatibility endpoint. Report actionable P0, P1 and P2 correctness, security, privacy and reliability defects, including issues beyond earlier review threads.
- Check live grants, revocation during discovery/replay, cross-organization references and private roster boundaries. Navigation projections and platform support roles grant no tenant authority. Validate the full legacy/canonical path and preserve lifecycle revision, idempotency and history invariants.
- Check timezone defaults, canonical instant ordering, DST gaps/repeated hours, pagination boundaries and realistic page read costs. Require meaningful regression tests for rendered behavior and authorization boundaries, not tests that only repeat helper implementation.
- Each new `@codex review` request must identify the exact current head and ask for a full PR diff pass including P2 bugs as well as P0/P1. The gate is a completed actual GitHub Codex review with no unresolved valid actionable findings, passing relevant CI and accurate original evidence; do not invent numeric review scores.
- P2.02 PR #26 already exceeds the two-review cap: request no further Codex reviews. Its unavailable current-head review gate remains unmet. Include handoff changes before settling the final review head, then freeze it; record final gate results in a PR comment without a ledger-only commit. Leave merging and P2.03 to the coordinator.
