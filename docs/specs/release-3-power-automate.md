# Release 3: Power Automate as an alternative Workflow Engine

**Epic:** [SCRUM-43](https://marcosportales2002.atlassian.net/browse/SCRUM-43)

**Goal:** the same FlowDesk can hand its Dispatches to Power Automate instead of n8n, reaching Microsoft 365 (Teams, Outlook) and the simulated ERP, while the app keeps deciding and reconciling exactly as before.

**Decisions:** [ADR 0011](../adr/0011-power-automate-as-alternative-workflow-engine.md), building on [ADR 0005](../adr/0005-app-decides-n8n-executes.md), [ADR 0006](../adr/0006-reconcile-before-retry.md) and [ADR 0009](../adr/0009-flowdesk-is-a-layer-in-front-of-the-erp.md). Vocabulary: Workflow Engine and Execution Reference in [GLOSSARY.md](../../GLOSSARY.md).

**Out of scope:** using both engines at once, or routing per Team or Category; HMAC on the Power Automate side (no Azure Function); reconciling against Power Automate run history; a stable named tunnel or a public hosted demo; real Power Automate in CI. n8n stays the default and `docker compose up` needs no Microsoft account.

| Task | Jira | Title | Blocked by |
| --- | --- | --- | --- |
| T12 | SCRUM-44 | Engine-neutral Execution Reference | — |
| T13 | SCRUM-46 | Workflow Engine selection and the Power Automate dispatch client | T12 |
| T14 | SCRUM-45 | Optional public tunnel profile for a cloud Workflow Engine | — |
| T15 | SCRUM-47 | Power Automate dispatch flow (Teams, Outlook, simulated ERP) | T13, T14 |
| T16 | SCRUM-48 | README, demo and verify for Power Automate | T15 |

## T12: Engine-neutral Execution Reference

- A migration renames the Dispatch Attempt column `n8n_execution_id` to `execution_reference`.
- The callback schema takes `execution_reference`; during the transition it also accepts `n8n_execution_id`, so the current n8n workflow keeps working until it is updated (the workflow JSON is updated in this task).
- New Ticket Events write `executionReference`. Events are never rewritten: the event schema still reads `n8nExecutionId` on old events and the timeline shows either.

**Accepted when:** existing tests pass with the new name; a callback with either field settles the Dispatch; a database with old events still renders every timeline.

## T13: Workflow Engine selection and the Power Automate dispatch client

- `WORKFLOW_ENGINE=n8n|power_automate` (default `n8n`), validated at worker start-up like the rest of the dispatch configuration. Power Automate needs `POWER_AUTOMATE_TRIGGER_URL` (kept as a secret, it carries `sig`) and `POWER_AUTOMATE_TO_FLOWDESK_SECRET`.
- The Power Automate client posts the same event body as the n8n client; `callback_url` points to `/api/webhooks/power-automate`.
- `/api/webhooks/power-automate` authenticates `Authorization: Bearer <POWER_AUTOMATE_TO_FLOWDESK_SECRET>` with a constant-time compare and then follows the same path as the n8n callback (`recordDispatchCallback`). The n8n route is unchanged; both stay active whatever `WORKFLOW_ENGINE` says.
- Each Dispatch Attempt records the Workflow Engine that ran it, shown on the attempt in the timeline. Automatic and manual retries go to the engine configured at the time of the attempt.
- A Power Automate stub in `tests/support/`, like `n8nStub.ts`.

**Accepted when:** with `WORKFLOW_ENGINE=power_automate` a Ticket's Dispatch reaches the stub and settles from its callback; a callback with no bearer, or a wrong one, is rejected with 401 and changes nothing; a Dispatch sent to n8n before switching still settles from n8n's callback; the default behaviour with `n8n` is unchanged.

## T14: Optional public tunnel profile for a cloud Workflow Engine

- A `power-automate` compose profile: a small reverse proxy exposing only `/callback` (the Power Automate callback route), `/notifier` and `/erp` on one host, behind a `cloudflared` quick tunnel (no Cloudflare account).
- A script reads the tunnel's public URL and writes `FLOWDESK_CALLBACK_URL` (the public `/callback`) to `.env`. The flow derives the notifier and ERP URLs from the origin of `callback_url` in each event, so a new tunnel URL needs no change to the flow.
- Everything else (web UI, API, Postgres, n8n) stays private.

**Accepted when:** `docker compose up` without the profile is unchanged; with it, the three routes answer through the public URL and nothing else does.

## T15: Power Automate dispatch flow (Teams, Outlook, simulated ERP)

Built in a Microsoft tenant with Premium connectors (for example the Power Apps Developer Plan), then exported and unpacked with `pac solution unpack` into `power-automate/`, next to `n8n/workflows/`.

- Trigger "When an HTTP request is received", with a JSON schema for the event. It does not verify the HMAC headers (ADR 0011).
- `erp` Category: create the incident in the simulated ERP with the `dispatch_id` as idempotency key and report its External Reference.
- Other Categories: ask the notifier whether the `dispatch_id` was already delivered; if not, post to the Team's channel (one Teams channel per FlowDesk Team, including `service_desk`), then record the delivery in the notifier. On the Urgent Route, also email a mailbox set as a solution environment variable, with the Team in the subject.
- Callback to `callback_url` with the bearer secret (a solution environment variable) and `execution_reference` = `workflow()['run']['name']`, reporting `failed` with the error when a step fails.
- The flow never retries a Dispatch and never decides Category, Priority or Team (ADR 0005, ADR 0006).

**Accepted when:** an urgent Ticket and a normal Ticket each produce one message in the right Teams channel, the urgent one also an email; an `erp` Ticket ends `succeeded` with an External Reference; a lost callback is reconciled through the notifier without a second Teams message in the normal case.

## T16: README, demo and verify for Power Automate

- README: choosing a Workflow Engine, what Power Automate needs (tenant, Premium connectors, tunnel), importing the solution, and setting its environment variables. The limitations section names the weaker authentication and the possible duplicate Teams message (ADR 0011).
- `docs/demo.md`: an optional Power Automate path.
- The `verify` skill: a manual step for changes touching the Power Automate path. CI keeps n8n and the stubs.

**Accepted when:** someone with a tenant can follow the README from an empty environment to a Ticket notified in Teams.
