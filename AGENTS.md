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

# Code Review Rules

- Review the complete PR diff and every affected caller, adapter, existing screen and compatibility endpoint. Report actionable P0, P1 and P2 correctness, security, privacy and reliability defects, including issues beyond earlier review threads.
- Check live grants, revocation during discovery/replay, cross-organization references and private roster boundaries. Navigation projections and platform support roles grant no tenant authority. Validate the full legacy/canonical path and preserve lifecycle revision, idempotency and history invariants.
- Check timezone defaults, canonical instant ordering, DST gaps/repeated hours, pagination boundaries and realistic page read costs. Require meaningful regression tests for rendered behavior and authorization boundaries, not tests that only repeat helper implementation.

# Workflow efficiency

Keep step prompts concise and refer to the existing plan and repository rules. Retrieve compact changed-state status with bounded waits and backoff; the implementation chat owns CI polling, and the coordinator checks milestones without duplicate polling. Avoid rereading unchanged files or dumping full tool responses. Use focused validation after fixes and retain all required delivery checks, acceptance and security tests, original UI evidence, and coordinator merge gates.
