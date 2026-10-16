# Issue tracker: Jira

Issues and specs for this repo live in Jira. Use the Atlassian MCP tools for all operations.

- **Site**: `https://marcosportales2002.atlassian.net`
- **cloudId**: `f87dd2aa-7ab0-474f-8d58-d13ca96c34e1` (pass it explicitly on every call)
- **Project key**: `SCRUM` (team-managed software project)
- **Issue types**: `Epic`, `Story`, `Task`, `Subtask`

## Conventions

- **Create an issue**: `createJiraIssue` with `projectKey: "SCRUM"`. Use `Story` for user-facing features, `Task` for chores and bugs, `Epic` for a parent spec that groups tickets.
- **Read an issue**: `getJiraIssue` with the issue key (e.g. `SCRUM-12`). Use `view: "evidence"` to include issue links. Comments come from `listJiraIssueComments` (find it via `discover`).
- **List issues**: `searchJiraIssuesUsingJql`, e.g. `project = SCRUM AND labels = ready-for-agent AND statusCategory != Done ORDER BY created ASC`.
- **Make an issue a child of a parent**: set the parent Epic when creating the child (`parent` field), or edit it afterwards with `editJiraIssue`. Use `Subtask` only for small steps within a single ticket.
- **Comment on an issue**: `addOrEditJiraIssueComment`.
- **Apply / remove labels**: `editJiraIssue`, updating the `labels` field. Jira creates a label the first time it's used.
- **Close**: comment with the outcome, then `transitionJiraIssue` to the Done status. Get valid transitions from `listJiraIssueTransitions`.

If you don't know the name of an operation, call the Atlassian `discover` tool. Never guess operation names.

## When a skill says "publish to the issue tracker"

Create an issue in project `SCRUM`.

## When a skill says "fetch the relevant ticket"

Read it as in **Read an issue** above.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single Epic, and its child issues are the tickets.

- **Map**: an `Epic` labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body in its description.
- **Child ticket**: an issue whose parent is the map Epic, labelled `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, it's assigned to the driving dev.
- **Blocking**: a Jira issue link of type "Blocks" (blocker *blocks* child). If links aren't available, fall back to a `Blocked by: SCRUM-<n>, ...` line at the top of the child's description. A ticket is unblocked once every blocker is in the Done status category.
- **Frontier query**: `project = SCRUM AND parent = <map-key> AND statusCategory != Done AND assignee IS EMPTY ORDER BY created ASC`, then drop any issue that has an unresolved blocker. The first remaining issue wins.
- **Claim**: assign the issue to the current user (`atlassianUserInfo` gives the accountId) with `editJiraIssue`. This is the session's first write.
- **Resolve**: comment with the answer, transition the issue to Done, then append a context pointer (gist + issue key) to the map's Decisions-so-far.
