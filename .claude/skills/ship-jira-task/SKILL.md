---
name: ship-jira-task
description: Run the Jira and GitHub lifecycle of a SCRUM ticket, from In Progress to merged and Done. Use when asked to work, implement, resolve or ship a SCRUM-<n> issue.
---

# Ship a Jira task

Tracker operations (cloudId, transitions, comments) are in `docs/agents/issue-tracker.md`. Work in a worktree off `main`.

1. **Claim.** Transition the ticket to In Progress.
2. **Implement** the ticket with `/implement`.
3. **Verify in the running app** with `/run` before opening the PR. A broken flow goes back to step 2.
4. **PR.** Write the body with `/pr`, title it with the ticket key, and embed a screenshot when the diff changes the UI. Push the branch.
5. **Merge** into `main` with `gh pr merge` once checks are green.
6. **Close the ticket.** Comment first, then transition to Done:

   `Implemented in PR #<n>: <files and exports touched> <how it is tested>. <anything that already existed, e.g. "Users already came with SCRUM-25">. Full suite, typecheck and lint pass.`

   Example: `Implemented in PR #21: src/domain/permissions.ts (isRequester, isOperator, canRunManualActions, ticketTeam) with table-driven tests covering all spec cases. Users and Team memberships already came with SCRUM-25. Full suite, typecheck and lint pass.`

Report the PR link and the ticket's final status.
