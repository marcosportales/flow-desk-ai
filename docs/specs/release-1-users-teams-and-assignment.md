# Release 1: sign-in, Teams and assignment

**Epic:** [SCRUM-23](https://marcosportales2002.atlassian.net/browse/SCRUM-23)

**Goal:** the demo shows who may do what. A Requester sees only their own Tickets and no Manual Actions; the Team in charge sees a queue, an Operator takes a Ticket, and every human action is attributed.

**Decisions:** [ADR 0007](../adr/0007-better-auth-and-per-ticket-capacities.md), [ADR 0008](../adr/0008-permission-from-team-assignment-is-accountability.md). Background: [SCRUM-22 research](../research/scrum-22-manual-actions-access.md). Vocabulary: [GLOSSARY.md](../../GLOSSARY.md).

**Out of scope:** automatic assignment, external per-person notifications, separation of duties (a User who is both Requester and Team member of a Ticket may act on it), a public hosted demo, any admin UI. Demo data is fictional and reseeded: the `requesters` table becomes Users and no data migration is written.

| Task | Jira | Title | Blocked by |
| --- | --- | --- | --- |
| T1 | SCRUM-25 | Sign in with Better Auth | — |
| T2 | SCRUM-27 | Team membership and the permission policy | T1 |
| T3 | SCRUM-28 | Requester sees only their own Tickets | T2 |
| T4 | SCRUM-29 | Operator sees the Team queue; Manual Actions hidden from non-Operators | T2 |
| T5 | SCRUM-30 | Enforce Manual Action permissions in Server Actions and API routes | T2 |
| T6 | SCRUM-32 | Take, release and reassign a Ticket | T4 |
| T7 | SCRUM-31 | Actor on Ticket Events | T2 (integrates with T6) |

T3, T4 and T5 can proceed in parallel once T2 lands. Authorization tests live inside each task, never in a separate one.

## T1: Sign in with Better Auth

Replace "pick a Requester from a list" with real sessions.

- Better Auth with the Drizzle adapter, email and password, cookie sessions; its tables come from a Drizzle migration.
- The seed creates fictional Users with a fixed demo password: at least one User in no Team, and Operators in each of `it_systems`, `identity_access`, `data_team` and `service_desk`, including one in two Teams.
- A sign-in page with "Sign in as <name>" shortcuts for the seeded Users. An environment variable turns the shortcuts off.
- Every page requires a session; unauthenticated visits redirect to sign-in. `/api/health`, `/api/webhooks/n8n` and the `X-API-Key` routes keep their current auth.
- Server Actions read the current User from the session.

**Accepted when:** an unauthenticated request to `/tickets` redirects to sign-in; each shortcut signs in as that User; sign-out ends the session; with shortcuts disabled the shortcuts are absent and the endpoint refuses them; `pnpm test` and lint pass.

## T2: Team membership and the permission policy

- A User belongs to zero or more Teams (use the existing `teams` values). The `requesters` table is replaced by Users; Tickets reference the User who raised them.
- A pure, unit-tested policy module in `src/domain`: for a User and a Ticket, answer `isRequester` (created it), `isOperator` (member of the Ticket's Team; a Ticket with no Team belongs to `service_desk`) and the derived `canRunManualActions`.
- The Team of a Ticket in Manual Review follows ADR 0008: `service_desk`, until classification gives it a Category.

**Accepted when:** table-driven tests cover Requester only, Operator only, both, neither, Ticket with Category, Ticket with no Category, and a User in two Teams.

## T3: Requester sees only their own Tickets

- The Ticket list and detail show a User only the Tickets they raised (plus Team Tickets once T4 lands); another User's Ticket id returns not-found, not forbidden.
- `/tickets/new` no longer asks who the Requester is: it submits as the signed-in User.
- The API keeps `requesterId` in the body (Integration submitting on behalf of a Requester).

**Accepted when:** User A cannot list or open User B's Ticket by URL; the form has no Requester selector; `POST /api/tickets` with the API key still works.

## T4: Operator sees the Team queue; Manual Actions hidden from non-Operators

- The list gains two scopes for a User with Team membership: "My requests" and "Team queue" (Tickets of their Teams; `service_desk` members also see Tickets with no Team).
- The Ticket detail renders the Manual Actions section only when `canRunManualActions`. A Requester who is not a Team member sees a read-only page with classification, Priority and the Priority Rules that fired, Dispatch history and the timeline.
- Update `docs/demo.md` scenarios that use Manual Review to say which User performs them.

**Accepted when:** a Requester-only User's detail page contains no Manual Actions; a Team member sees them; a User in two Teams sees both queues; a User who is both Requester and Team member sees the Manual Actions.

## T5: Enforce Manual Action permissions in Server Actions and API routes

- Every Manual Action (re-run AI, classify manually, Priority Override, change Ticket Status, Retry Dispatch) checks `canRunManualActions` on the server and returns forbidden otherwise, both as Server Actions and under `/api/tickets/[id]/*` and `/api/dispatches/[id]/retry`.
- Those API routes accept an Operator session, not the API key. The API key keeps create, read and list.
- Update `scripts/demo-e2e.ts` and affected tests to sign in as an Operator.

**Accepted when:** a Requester-only User receives forbidden on each Manual Action even when calling it directly; the API key receives forbidden on the Manual Action routes and still creates and reads Tickets; the e2e script passes.

## T6: Take, release and reassign a Ticket

- `assignee` on Ticket (nullable User). A Team Operator can take an unowned Ticket, release it (any Operator of the Team, so a colleague can cover for an absent Assignee, per ADR 0008), or reassign to another member of the same Team. Reassigning outside the Team is refused.
- The queue gains "Unassigned" and "Mine" filters; the detail page shows the Assignee.
- Taking is atomic: two Operators taking at once yield one Assignee and a clear error for the other.

**Accepted when:** the above, plus a concurrency test for simultaneous takes.

## T7: Actor on Ticket Events

- Every Ticket Event records its actor: a User, an Integration, or the system.
- Human-initiated events (Priority Override, manual classification, status change, take/release/reassign, Retry) record the signed-in User; AI, Priority Rules and Dispatch events record the system; Request creation through the API records the Integration.
- The timeline shows the actor. Existing events are appended-only and stay unchanged; seeded ones are regenerated.

**Accepted when:** each event type is covered by a test asserting its actor, and the timeline renders it.
