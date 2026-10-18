# Release 2: notifications, simulated ERP and the two-role demo

**Goal:** the app reads as an automation platform, not a form: people are told when something concerns them, an ERP-category Ticket produces a record in an external system, and the demo and README tell that story for both kinds of User.

**Decisions:** [ADR 0009](../adr/0009-flowdesk-is-a-layer-in-front-of-the-erp.md), building on [ADR 0005](../adr/0005-app-decides-n8n-executes.md) and [ADR 0006](../adr/0006-reconcile-before-retry.md). Depends on [Release 1](release-1-users-teams-and-assignment.md) except T9.

**Out of scope:** email, Slack or any external per-person notification; real SAP; a public hosted deployment (ADR 0002 stays local-first); automatic assignment.

| Task | Title | Blocked by |
| --- | --- | --- |
| T8 | In-app Notifications | R1-T6 |
| T9 | Simulated ERP target with an External Reference | — |
| T10 | Requester closes or reopens their own Ticket | R1-T3 |
| T11 | README and demo for two Users | T8, T9, T10 |

## T8: In-app Notifications

- A `notifications` table and a bell in the header with an unread count and a list; opening one marks it read and links to the Ticket.
- Created for: the Assignee when a Ticket is assigned or reassigned to them; the Team's Operators when a Ticket enters their queue; the Requester when their Ticket is assigned, resolved or closed.
- The existing Dispatch to the Team channel is unchanged.

**Accepted when:** each trigger creates exactly one Notification per recipient (no duplicates on retried requests), a User sees only their own, and unread counts update after reading.

## T9: Simulated ERP target with an External Reference

- A small simulated ERP service next to the notifier: creates an incident record from a Ticket, idempotent on `dispatch_id`, answers "did you receive this id?" for Reconciliation, and has failure modes like the notifier.
- The n8n workflow gains an `erp` branch that calls it and reports the External Reference in the callback; the app stores it on the Ticket and shows it on the detail page and the list.
- Update `docker-compose.yml`, the workflow JSON and `docs/demo.md`.

**Accepted when:** an `erp` Ticket ends with a Dispatch `succeeded` and an External Reference; a lost response is reconciled without creating a second ERP record; other Categories are unaffected.

## T10: Requester closes or reopens their own Ticket

- The only control a Requester-only User gets on their Ticket: close it ("fixed") or reopen it ("still broken"), within the existing Ticket Status transitions, with a short reason recorded in the timeline under their name.
- Enforced on the server like the Manual Actions.

**Accepted when:** a Requester can close and reopen only their own Ticket; every other Manual Action stays forbidden; the events carry the User as actor.

## T11: README and demo for two Users

- README: positioning against an ERP (ADR 0009), the sign-in shortcuts, an updated limitations section (no admin, no automatic assignment, simulated ERP) and an ADR table extended through 0009.
- `docs/demo.md` rewritten for a Requester and an Operator, including the ERP Ticket and the Notification; `pnpm demo:e2e` covers the new path.

**Accepted when:** someone who has not seen the code can follow `docs/demo.md` end to end, and `pnpm demo:e2e` passes.
