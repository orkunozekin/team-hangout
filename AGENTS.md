# Expo SDK 54

This project uses Expo SDK 54. Read the exact versioned docs at https://docs.expo.dev/versions/v54.0.0/ before writing any code.

# Pull requests

- Deliver repository changes through a pull request targeting `main`. Use a `codex/` branch unless the user specifies another branch. Open the PR as part of completing the work; do not stop at a local commit or branch push. A direct push to `main` requires an explicit user instruction for that change.
- Keep PR titles and descriptions short and simple. No em dashes or hard-wrapped paragraphs.
- Include what changed, why, and relevant validation. Do not merge or enable auto-merge unless the user explicitly requests it.

# UI evidence

- For every change to screens, components, layout, styling, or user-visible interactions, run the affected UI and capture screenshots of the changed states. Use a simulator or device for native UI and an appropriate browser capture tool for web UI. Verify that the running app belongs to the PR's checkout and includes its latest changes.
- Inspect the screenshots, fix visible problems, and recapture after changes affecting the captured UI. Cover the relevant interaction results and changed loading, empty, or error states where applicable. Use non-sensitive development data.
- Include the screenshots in the PR description under **UI evidence**, with brief captions explaining the state and behavior shown. Upload attachments or use a repository-approved location accessible to reviewers and embed the images. Local filesystem paths alone do not count as PR evidence. Keep scratch captures out of source commits unless the repository adopts a committed-artifact convention.
- If the app cannot run, a state cannot be reached, or images cannot be attached, describe the exact blocker in the PR and final handoff, retain any local captures, and keep the PR in draft until the evidence is supplied or the user explicitly accepts the limitation. Do not claim visual verification without inspecting real captures.
- Documentation-only and other changes without a user-visible UI effect do not require screenshots; state that UI evidence is not applicable in the PR.

# AI review feedback loop

- After opening a PR, check its checks, review summaries, conversation comments, and unresolved inline review threads. Wait for configured AI review checks to finish when available. Do not treat an absent review as approval; report a missing or unavailable reviewer explicitly.
- Use the local `address-pr-feedback` skill when available. Review AI feedback first, then human feedback. Fix valid in-scope issues, run appropriate validation, commit, and push. Explain feedback that is incorrect, obsolete, or outside scope instead of blindly implementing it. Ask the user when a material product or security decision is unresolved.
- Reply to addressed threads and resolve bot threads once fixed or intentionally declined with a reason. Do not resolve human threads without explicit user authorization.
- After fixes are pushed and the bot threads are addressed, post a **new top-level PR comment** tagging each relevant AI review bot and briefly summarize the fixes or dispositions. Use `@greptileai` for that reviewer; verify other bots' mention handles from the PR or configuration. Do not use a PR description edit or an edit to an old comment as the re-review request.
- Wait for the requested re-review and repeat the feedback loop when it identifies additional valid issues. Use bounded waits, avoid duplicate tags while a review is running, and report unavailable reviews or blockers rather than claiming completion.
- Preserve review-bot additions to the PR description. If screenshots or other requested content must be added later, fetch the latest description and preserve bot-owned sections verbatim.
- Before reporting the PR ready, refresh its state and confirm relevant checks pass, available AI review feedback is addressed, and required UI evidence matches the latest UI changes. Report any unresolved items and leave merging to the user.
