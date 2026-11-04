---
name: address-feedback
argument-hint: [feedback in any form: pasted list, prose, file path, URL, screenshot]
description: Take feedback in any form, split it into items, group them by logic and code proximity, start one sub-agent session per group, and have each one open a PR, loop on Greptile review with /address-pr-feedback until Greptile scores 5/5 with green CI, then merge its own PR.
disable-model-invocation: true
---

# /address-feedback

Invoking this skill is the user's standing instruction: "Group these feedback items by logic or code proximity, then start new agents in sub-agent sessions of this chat to address them. Each agent raises a PR, listens for Greptile's feedback, runs /address-pr-feedback, and repeats until Greptile scores 5/5. Then merge the PRs." Don't wait for them to repeat it. The merge authorization covers only PRs opened by this run, only after the gate below passes.

## 1. Collect and group the items

1. Gather the feedback from whatever was given: a numbered or bulleted list, free-form prose, a pasted chat or review, a file path, a URL or issue, or screenshots. Read files and links; describe what screenshots show. Split it into discrete, actionable items and number them, keeping the user's wording. Merge duplicates. If something is ambiguous, keep it as an item and note the open question rather than guessing.
2. Read enough of the codebase to know which files each item touches. Group items that share screens, components or a concern (navigation shell, card content, design system, backend endpoint, and so on). Aim for 2 to 4 groups; one item can stand alone if it touches nothing else.
3. Give each group explicit **file ownership**: the files it owns, and the files owned by other groups that it may only touch minimally (for example to swap in a shared component). Shared foundations (theme, shared UI kit) belong to exactly one group.
4. Show the user the grouping as a short list (group letter, item numbers, one-line scope), then start the sessions without waiting for approval unless an item needs a product decision you can't make; ask about only that item.

## 2. Start one session per group

Use `start_session` with `initiation: "user_asked"`, `context: "fresh"`, `use_worktree: true`, one session per group, with a bold title line before each call and a chapter mark before the batch. If sessions can't be started (for example over Remote Control), fall back to background `Agent` calls with `isolation: "worktree"` carrying the same brief, and say so in one line.

Each brief must be self-contained and include:
- The items verbatim, with what done looks like for each.
- File ownership from step 1, plus: if `main` moves, merge `origin/main` into the branch (never rebase or force-push) and resolve conflicts.
- Repo rules: follow the repo's AGENTS.md / CLAUDE.md (branch prefix, PR style, UI evidence). Only Greptile reviews; never tag `@codex` or other review bots.
- Isolation for parallel local runs: a distinct simulator/emulator device per session, a distinct Metro/dev-server port, and distinct backend emulator ports where the stack has them (for Firebase, a copy of the emulator config outside the repo with shifted ports, passed to the app through its port env vars). Name the specific values.
- How to run the app locally and any test data or logins this conversation already established; never real production data or credentials.
- Validation: focused tests for each item, the repo's typecheck and unit suites, and UI evidence when screens change.
- The review loop and merge gate below, verbatim.

### Review loop and merge gate (put this in every brief)

> After opening the PR, wait for Greptile's automatic review with bounded waits and backoff. Then run `/address-pr-feedback` on the PR. If that skill or the plugin it wraps is unavailable, do its steps directly: verify each finding against the code, fix valid ones with tests, commit and push, reply on every thread with what changed (or why it was declined), resolve the threads, then post a new top-level PR comment `@greptileai` to request a re-review. Repeat until Greptile's latest summary on the current head gives 5/5 confidence, every required CI check passes on that head, and no review threads are unresolved. Then squash-merge with `gh pr merge <n> --squash --match-head-commit <head sha>`. If Greptile hasn't responded about 30 minutes after a re-tag, or the score is stuck below 5/5 after three rounds with no new actionable findings, stop and report the PR, the score and the remaining findings instead of looping or merging.

## 3. Coordinate while they run

- Session notes arrive as messages; check each claimed result against GitHub (`gh pr view`, `gh pr checks`, review threads) before relaying it.
- If two sessions conflict (overlapping files, both needing the same port or device), message the affected session with the concrete resolution.
- Relay any product question a session raises to the user; don't answer product calls yourself.

## 4. Report

When every session has merged or stopped, give the user one summary: per group, the PR link, merge commit or stop reason, Greptile's final score, and anything left unverified (for example screens not checked on a device).
