---
name: ship-jira-task
description: Take a Jira SCRUM ticket from In Progress to merged and Done. Use when asked to work, implement, resolve or ship a SCRUM-<n> issue.
---

# Ship a Jira task

Tracker operations (cloudId, transitions, comments) are in `docs/agents/issue-tracker.md`. Work in a worktree off `main`.

1. **Claim.** Read the ticket and its spec. `transitionJiraIssue` to In Progress (see `listJiraIssueTransitions`).
2. **Resolve.** Build it test-first with `/tdd`. Done when `pnpm test`, `pnpm typecheck` and `pnpm lint` all pass.
3. **Verify in the running app.** Start the app with `/run` and exercise the feature as a user would. Unit tests passing is not verification. A broken flow goes back to step 2.
4. **Screenshot** when the diff touches UI (anything under `src/app` or components): capture the changed screen for the PR. No UI change, no image.
5. **PR.** Write the body with `/pr`, embed the screenshot, link the ticket key in the title. Push the branch.
6. **Merge** the PR into `main` (`gh pr merge`) once checks are green. Pull `main`.
7. **Close the ticket.** Comment first, then transition to Done:

   `Implemented in PR #<n>: <files and exports touched> <how it is tested>. <anything that already existed, e.g. "Users already came with SCRUM-25">. Full suite, typecheck and lint pass.`

   Example: `Implemented in PR #21: src/domain/permissions.ts (isRequester, isOperator, canRunManualActions, ticketTeam) with table-driven tests covering all spec cases. Users and Team memberships already came with SCRUM-25. Full suite, typecheck and lint pass.`

Report the PR link and the ticket's final status.
