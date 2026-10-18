# Agent guardrails: make the easy path the right one

**Epic:** [SCRUM-36](https://marcosportales2002.atlassian.net/browse/SCRUM-36)

**Goal:** an agent working on this repo does the right thing by default, and is told by a check when it doesn't. Invariants that today hold only because every author remembers them become true by construction or fail CI.

**Decisions:** [ADR 0010](../adr/0010-invariants-live-in-code-not-prose.md). Respects the layering in `docs/plan/IMPLEMENTATION.md` and the actor rules of [ADR 0008](../adr/0008-permission-from-team-assignment-is-accountability.md).

**Out of scope:** new product behaviour; formal verification; rewriting existing tests; changing the database schema beyond column types.

| Task | Jira | Title | Blocked by |
| --- | --- | --- | --- |
| G1 | SCRUM-37 | CI on every pull request | — |
| G2 | SCRUM-40 | Enforce layer boundaries with ESLint | G1 |
| G3 | SCRUM-38 | Typed Ticket Events | — |
| G4 | SCRUM-41 | One write path for status changes and Ticket Events | G3 |
| G5 | SCRUM-39 | One gate for Manual Actions | — |
| G6 | SCRUM-42 | `verify` skill for agents | G1 |

## G1: CI on every pull request

- A GitHub Actions workflow on pull requests and on pushes to `main`: install with pnpm, then `pnpm format:check`, `pnpm lint`, `pnpm typecheck` and `pnpm test`, with a Postgres service for `tests/support/globalSetup.ts`.
- Make `main` require it to pass.

**Accepted when:** a PR that breaks any of the four commands shows a red check, and a clean PR shows green.

## G2: Enforce layer boundaries with ESLint

- `no-restricted-imports` in `eslint.config.mjs`: `src/domain/**` imports nothing from `@/infra`, `@/services`, `@/app`, `next` or `drizzle-orm`; `src/app/**` imports neither `drizzle-orm` nor `@/infra/db/schema` (types included).
- Move the queries now made in `src/app/sign-in/page.tsx` and `src/app/api/requesters/route.ts` into `src/services/`, and stop `src/app/api/tickets/route.ts` importing the schema type.

**Accepted when:** `pnpm lint` passes on `main` and fails if any of those imports is added back.

## G3: Typed Ticket Events

- A discriminated union of Ticket Event types and their `data` in `src/domain/` (one zod schema per type), used as `$type<>()` on `ticket_events.type` and `data` in `src/infra/db/schema.ts`.
- Every existing insert compiles against it; reads in the timeline narrow on `type`.

**Accepted when:** inserting an unknown type, or `data` of the wrong shape for its type, is a type error; existing tests pass.

## G4: One write path for status changes and Ticket Events

- One function per status axis (Ticket Status, Classification State, Dispatch Status) that checks the transition with `src/domain/transitions.ts`, updates the row and appends the Ticket Event in the caller's transaction; one function to append any other Ticket Event.
- The services in `src/services/` use them instead of writing `status` or inserting into `ticket_events` themselves.
- A lint rule (or architecture test) fails if `status` is set or `ticket_events` is inserted into anywhere else, seed excepted.

**Accepted when:** no service writes a status or a Ticket Event directly; an illegal transition cannot be persisted by any code path; existing tests pass.

## G5: One gate for Manual Actions

- One way to define a Manual Action that authorizes the caller (Operator of the Ticket's Team, or the Ticket's Requester for close and reopen), runs the service with the User as actor, and on success revalidates `/tickets` and `/tickets/[id]`; both the Server Actions in `src/app/tickets/[id]/actions.ts` and the routes under `src/app/api/` go through it.
- An architecture test fails if a `POST` route under `src/app/api/tickets/[id]/` or `src/app/api/dispatches/[id]/` does not use it.

**Accepted when:** a new Manual Action cannot skip the permission check or the revalidation without the test failing; ADR 0008's behaviour is unchanged.

## G6: `verify` skill for agents

- A project skill at `.claude/skills/verify/SKILL.md` that tells an agent how to prove a change works before opening a PR: start the stack (`docker compose up`, migrate, seed), run the four CI commands and `pnpm demo:e2e`, then use the Playwright MCP to sign in through the demo shortcuts as the Requester and the Operator and walk the story's acceptance criteria in the UI.
- Ignore `.playwright-mcp/` in `.gitignore`.

**Accepted when:** an agent following only the skill can verify SCRUM-33 end to end in the browser.
