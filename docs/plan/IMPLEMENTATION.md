# FlowDesk AI — Implementation Plan

Derived from [PLAN.md](./PLAN.md) through a design review. Vocabulary follows [GLOSSARY.md](../../GLOSSARY.md); architectural decisions are recorded in [docs/adr/](../adr/).

| ADR | Decision |
|-----|----------|
| [0001](../adr/0001-ai-extracts-facts-rules-decide.md) | AI extracts facts; deterministic rules decide Priority and Team |
| [0002](../adr/0002-long-running-local-first-deployment.md) | Local-first, long-running deployment via Docker Compose |
| [0003](../adr/0003-openai-compatible-llm-provider.md) | OpenAI-compatible LLM provider behind a Classifier interface |
| [0004](../adr/0004-background-processing-via-postgres-jobs.md) | Background processing via a Postgres job table and a worker |
| [0005](../adr/0005-app-decides-n8n-executes.md) | The app decides; n8n executes and reports back |
| [0006](../adr/0006-reconcile-before-retry.md) | Reconcile before retry; the worker is the only retry owner |

---

## 1. System overview

```
             ┌──────────────┐  POST /api/tickets (Idempotency-Key)
 Requester ─►│  Next.js app │──────────────┐
  (UI/API)   │  (UI + API)  │              ▼
             └──────┬───────┘      ┌──────────────┐
                    │ reads        │  PostgreSQL  │◄────────┐
                    ▼              │  app DB      │         │ claims jobs
             ┌──────────────┐      │  (+ n8n DB)  │  ┌──────┴──────┐
             │  Dashboard   │      └──────────────┘  │   Worker    │──► LLM (OpenAI-compatible)
             └──────────────┘              ▲         └──────┬──────┘
                                           │ callback       │ signed Dispatch event
                                           │ (HMAC)         ▼
                                    ┌──────┴───────────────────┐
                                    │           n8n            │
                                    │ verify → switch Team/    │
                                    │ Urgent Route → deliver   │
                                    └──────────────┬───────────┘
                                                   │ Idempotency-Key = dispatch_id
                                                   ▼
                                    ┌──────────────────────────┐
                                    │ Simulated notification   │
                                    │ service (failure toggle) │
                                    └──────────────────────────┘
```

### Compose services

| Service | Image / source | Purpose |
|---------|----------------|---------|
| `postgres` | `postgres:16` | Databases `flowdesk` (app) and `n8n`; init script creates both |
| `app` | this repo (`next start`) | UI, public API, n8n callback webhook |
| `worker` | this repo (`tsx src/worker/main.ts`) | Claims jobs: classify, dispatch, reconcile |
| `n8n` | `n8nio/n8n` (pinned) | Runs the dispatch workflow |
| `n8n-import` | `n8nio/n8n` one-shot | `n8n import:workflow` from `n8n/workflows/*.json` on first start |
| `notifier` | `services/notifier` (tiny Node HTTP server) | Simulated notification target with failure modes and a received-messages page |
| `tunnel-proxy` | `caddy` (pinned), profile `power-automate` | Exposes only the Power Automate callback and the notifier and ERP routes the flow calls |
| `tunnel` | `cloudflare/cloudflared` (pinned), profile `power-automate` | Quick tunnel to `tunnel-proxy`; `pnpm tunnel:url` writes its `/callback` to `.env` |

`migrate` runs as a one-shot step before `app` and `worker` start (`drizzle-kit migrate` + seed).

### Repository layout

```
src/
  app/                    Next.js App Router (pages, server actions, route handlers)
    api/…                 public API + webhooks
  domain/                 pure logic, no I/O: priority rules, team table, state transitions, schemas
  services/               use cases: createTicket, classifyTicket, dispatchTicket, retryDispatch, …
  infra/
    db/                   Drizzle schema, client, migrations
    classifier/           Classifier interface, OpenAI-compatible impl, fake impl
    workflowEngine/       Workflow Engine selection and event client (n8n signed, Power Automate)
    crypto/               HMAC sign/verify
  worker/                 job loop and handlers
services/notifier/        simulated notification service
n8n/workflows/            exported workflow JSON
docs/                     plan, ADRs, API docs
tests/                    vitest (unit + integration against real Postgres)
```

Both Route Handlers and Server Actions call `src/services/*`; neither contains business logic.

---

## 2. Domain rules

### 2.1 Categories → Team

| Category | Team | Dispatched? |
|----------|------|-------------|
| `erp` | `it_systems` | yes |
| `access` | `identity_access` | yes |
| `data` | `data_team` | yes |
| `inquiry` | `service_desk` | no, goes to Manual Review |
| `other` | `service_desk` | no, goes to Manual Review |

### 2.2 Classification schema (AI output)

```ts
const Classification = z.object({
  category: z.enum(["erp", "access", "data", "inquiry", "other"]),
  summary: z.string().min(1).max(200),
  blocks_work: z.boolean(),
  impact_scope: z.enum(["individual", "team", "organization"]),
  reason: z.string().min(1).max(500),
}).strict();
```

The prompt asks for JSON only and includes the allowed values. Use `response_format: { type: "json_schema" }` if the provider supports it, otherwise `{ type: "json_object" }`, otherwise plain text with a JSON fence. The output is **always** parsed and Zod-validated regardless of which one was used.

### 2.3 Priority Rules (ordered, first match wins)

| # | Name | Condition | Priority |
|---|------|-----------|----------|
| 1 | `org_wide_blocker` | `blocks_work && impact_scope = organization` | `urgent` |
| 2 | `erp_blocker` | `category = erp && blocks_work` | `urgent` |
| 3 | `team_blocker` | `blocks_work && impact_scope = team` | `high` |
| 4 | `individual_blocker` | `blocks_work` | `normal` |
| 5 | `default` | always | `low` |

`evaluatePriority(facts) → { priority, rule, evaluated: RuleResult[] }` is pure. The matched rule and the full evaluation are stored on the Ticket and in a `priority_computed` Ticket Event. Route = `urgent` if Priority is `urgent`, otherwise `standard`.

### 2.4 Status axes

| Axis | Values | Transitions |
|------|--------|-------------|
| Ticket Status | `open`, `resolved`, `closed` | open→resolved→closed; resolved→open (reopen) |
| Classification State | `pending`, `classified`, `needs_review` | pending→classified; pending→needs_review; needs_review→classified (manual or re-run); classified→classified (manual correction) |
| Dispatch Status | `pending`, `sent`, `succeeded`, `failed`, `unknown` | pending→sent→succeeded / failed; pending→failed (n8n never accepted it and the auto-retry budget ran out, §4.4); sent→unknown (callback deadline passed); unknown→succeeded / failed (Reconciliation); failed→pending (retry, same Dispatch) |

Transitions live in `src/domain/transitions.ts` as explicit functions that throw on illegal moves. They are unit-tested.

### 2.5 Failure policies

| Failure | Policy |
|---------|--------|
| LLM provider error (timeout 20s, 5xx, 429, network) | Job retry with backoff (2s, 8s, 30s), max 3 attempts, then `needs_review` |
| LLM invalid output | One repair call with the Zod error included in the prompt; if still invalid, `needs_review` |
| n8n unreachable / non-2xx on dispatch | Attempt `failed`; auto-retry with backoff, max 3 auto attempts; then Dispatch `failed`, manual Retry offered |
| n8n reports delivery failure via callback | Same as above |
| No callback within 60s of `sent` | Dispatch → `unknown`; enqueue `reconcile` job |
| Reconciliation: delivery found | Dispatch → `succeeded` |
| Reconciliation: not found | Dispatch → `failed` (auto-retry budget applies) |
| Reconciliation: notifier unreachable | Stays `unknown`; reconcile retried with backoff |

---

## 3. Data model (Drizzle / PostgreSQL)

All ids are `uuid` (generated with `gen_random_uuid()`) unless noted. Every table has `created_at timestamptz default now()`. Enums are Postgres enums.

### `requesters`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| name | text not null | fictional |
| email | text not null unique | `@flowdesk.example` |
| department | text not null | |

### `tickets`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| number | integer generated always as identity, unique | shown as `FD-0001` |
| requester_id | uuid fk → requesters not null | |
| title | text not null | check length 3..200 |
| description | text not null | check length 10..5000; the Request, never modified |
| status | ticket_status not null default `open` | |
| classification_state | classification_state not null default `pending` | |
| category | category null | |
| summary | text null | |
| blocks_work | boolean null | |
| impact_scope | impact_scope null | |
| classification_source | enum(`ai`,`human`) null | |
| priority | priority null | effective priority |
| computed_priority | priority null | what the rules produced |
| priority_rule | text null | matched rule name |
| priority_override_reason | text null | |
| team | team null | |
| idempotency_key | text not null | |
| request_hash | text not null | sha256 of normalized (requester_id, title, description) |
| updated_at | timestamptz not null | |

Constraints:
- `unique (requester_id, idempotency_key)`. A repeated key with the same `request_hash` returns the existing Ticket (`200`). A repeated key with a different hash returns `409`.
- `check (classification_state <> 'classified' or (category, summary, blocks_work, impact_scope, priority, computed_priority, team, classification_source) all not null)`.
- `check ((priority is distinct from computed_priority) = (priority_override_reason is not null))`, i.e. an override always carries a reason.
- Indexes: `(status)`, `(classification_state)`, `(category)`, `(priority)`, `(created_at desc)`, trigram or `ILIKE` index on `title` (pg_trgm, optional).

### `classification_attempts`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| ticket_id | uuid fk not null | |
| attempt_no | int not null | unique `(ticket_id, attempt_no)` |
| kind | enum(`initial`,`repair`,`rerun`) | |
| outcome | enum(`valid`,`invalid_output`,`provider_error`) | |
| provider / model | text | |
| raw_output | text null | kept for invalid outputs, for Scenario D inspection |
| parsed | jsonb null | validated Classification |
| error | text null | |
| latency_ms | int null | |

### `dispatches`
| column | type | notes |
|---|---|---|
| id | uuid pk | **the dispatch_id / idempotency key end-to-end** |
| ticket_id | uuid fk not null | |
| sequence | int not null | unique `(ticket_id, sequence)` |
| category, priority, team | enums not null | snapshot of the routing decision |
| route | enum(`standard`,`urgent`) not null | |
| status | dispatch_status not null default `pending` | |
| auto_attempts | int not null default 0 | |
| callback_deadline | timestamptz null | set when `sent` |
| superseded_by | uuid null fk → dispatches | when a routing change created a newer Dispatch |
| updated_at | timestamptz | |

Partial unique index: at most one non-terminal Dispatch per Ticket: `unique (ticket_id) where status in ('pending','sent','unknown')`.

### `dispatch_attempts` (append-only)
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| dispatch_id | uuid fk not null | |
| attempt_no | int not null | unique `(dispatch_id, attempt_no)` |
| trigger | enum(`auto`,`manual`,`reconcile`) | |
| workflow_engine | enum(`n8n`,`power_automate`) null | the Workflow Engine that ran the attempt (ADR 0011); null on a `reconcile` attempt |
| outcome | enum(`sent`,`succeeded`,`failed`,`unknown`) | |
| http_status | int null | |
| execution_reference | text null | the Execution Reference, from callback (`n8n_execution_id` before Release 3); the callback settles the in-flight (latest) attempt's `outcome`, `error`, `finished_at`. Earlier attempts are never touched |
| error | text null | |
| started_at / finished_at | timestamptz | |

### `jobs`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| kind | enum(`classify`,`dispatch`,`reconcile`) | |
| ticket_id | uuid fk not null | |
| dispatch_id | uuid fk null | |
| status | enum(`queued`,`running`,`done`,`dead`) | |
| run_at | timestamptz not null default now() | backoff scheduling |
| attempts / max_attempts | int | |
| locked_at / locked_by | timestamptz / text | lease; a `running` job whose lock is older than 2 minutes is reclaimable |
| last_error | text null | |

Partial unique index: `unique (kind, ticket_id, coalesce(dispatch_id, '00000000-…')) where status in ('queued','running')`, which stops the same job being enqueued twice.

### `ticket_events` (append-only)
| column | type | notes |
|---|---|---|
| id | bigint identity pk | ordering |
| ticket_id | uuid fk not null | index `(ticket_id, id)` |
| type | text not null | one of the Ticket Event types in `src/domain/ticketEvents.ts`, e.g. `ticket_created`, `classified`, `priority_computed`, `dispatch_succeeded`, `status_changed` |
| actor | enum(`system`,`ai`,`human`,`n8n`) | |
| data | jsonb not null | shaped by `type`: one zod schema per type in `src/domain/ticketEvents.ts` |

**Rule:** every state change and its Ticket Event are written in the same transaction, together with any follow-up job.

---

## 4. Processing pipeline

### 4.1 Create Ticket (`services/createTicket`)
One transaction:
1. Validate input with Zod; hash the request.
2. `insert … on conflict (requester_id, idempotency_key) do nothing returning *`. If the conflict row's hash matches, return it; if not, return 409.
3. Insert the `ticket_created` event and the `classify` job.

Responds `202 { ticket }` (or `200` for an idempotent replay).

### 4.2 Worker loop
```
loop:
  BEGIN
  SELECT … FROM jobs WHERE status='queued' AND run_at<=now()
     OR (status='running' AND locked_at < now()-'2 min')
  ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT 1
  mark running, locked_by, locked_at; COMMIT
  run handler (outside the claim transaction)
  handler commits its own result + events + follow-up jobs + marks job done
  on throw: attempts++, run_at = now()+backoff, or 'dead' when exhausted
  sleep 1s when idle
```
A separate tick (every 10s) finds `sent` Dispatches past `callback_deadline`, marks them `unknown` and enqueues `reconcile`.

### 4.3 Classify handler
- Fake or OpenAI-compatible Classifier → validate → (repair once if invalid) → in one transaction: store the attempt(s), set facts, `evaluatePriority`, team lookup, `classified`, events.
- If the Category is dispatchable: create a Dispatch (`pending`) and a `dispatch` job in the same transaction.
- If it isn't, or validation failed after repair: `needs_review` and a `sent_to_review` event with the reason.
- Provider errors throw, so the job retries. On the final failure the handler moves the Ticket to `needs_review` instead of letting the job go `dead` silently.

### 4.4 Dispatch handler
- POST the signed event to the n8n webhook. Payload:
  ```json
  { "dispatch_id": "…", "ticket": { "id": "…", "number": "FD-0042", "title": "…", "summary": "…" },
    "category": "erp", "priority": "urgent", "team": "it_systems", "route": "urgent",
    "callback_url": "http://app:3000/api/webhooks/n8n" }
  ```
- Headers: `X-FlowDesk-Timestamp`, `X-FlowDesk-Signature: sha256=HMAC(secret, timestamp + "." + body)`.
- n8n answers `202` immediately → attempt `sent`, Dispatch `sent`, `callback_deadline = now()+60s`.
- Non-2xx or a network error → attempt `failed`; if `auto_attempts < 3`, re-enqueue with backoff, otherwise Dispatch `failed`.

### 4.5 Callback webhook (`POST /api/webhooks/n8n`)
- Verify the HMAC (separate secret) and reject a timestamp skew over 5 minutes.
- Body: `{ dispatch_id, outcome: "succeeded" | "failed", error?, execution_reference, delivered_at?, external_reference? }`; `n8n_execution_id` is accepted in place of `execution_reference`. On `succeeded`, `external_reference` (an ERP incident number) is stored on the Ticket (ADR 0009).
- Idempotent: a callback for an already-terminal Dispatch is recorded as an event and otherwise ignored. A callback arriving while the Dispatch is `unknown` settles it.

### 4.6 Reconcile handler
`GET notifier/deliveries/{dispatch_id}`, or `GET erp/incidents/{dispatch_id}` for an `erp` Dispatch: found → `succeeded` (an ERP incident's `reference` becomes the External Reference); 404 → `failed` (then auto-retry if budget remains); unreachable → throw (job retries).

### 4.7 Manual actions
| Action | Allowed when | Effect |
|--------|--------------|--------|
| Retry Dispatch | Dispatch `failed` | → `pending`, new `dispatch` job (trigger `manual`), same `dispatch_id` |
| Re-run classification | `needs_review` | new `classify` job (kind `rerun`) |
| Manual classification | `needs_review` or `classified` | human enters facts → rules recompute → if routing (team/route) changed and Category is dispatchable: supersede the active Dispatch (if any) and create a new one |
| Priority Override | `classified` | requires reason; if the route changes → new Dispatch |
| Change Ticket Status | per 2.4 | event only; no Dispatch |
| Resolve an Inquiry | `needs_review` + category `inquiry` | Ticket Status → `resolved` |

---

## 5. n8n workflow (`n8n/workflows/flowdesk-dispatch.json`)

1. **Webhook** (POST `/webhook/flowdesk-dispatch`, respond immediately with 202). Raw body enabled.
2. **Code: verify signature**: recompute the HMAC using `$env.FLOWDESK_TO_N8N_SECRET`; on mismatch, stop (no callback, logged as an execution error).
3. **Code: validate payload**: required fields and allowed enum values.
4. **IF `category = erp`** → **HTTP Request → ERP** `POST /incidents` with `Idempotency-Key: {{dispatch_id}}`, same timeout and no retries, then straight to step 6 with the incident's `reference` as `external_reference` (ADR 0009). Otherwise:
   **Switch on `team`** → **Set** node per team building the message (channel name, template). An IF on `route = urgent` prefixes `[URGENT]` and targets the urgent channel.
5. **HTTP Request → notifier** `POST /deliveries` with `Idempotency-Key: {{dispatch_id}}`, timeout 10s, *continue on fail*, **no retries**.
6. **Code: build callback**: outcome from step 5, `$execution.id`, HMAC with `$env.N8N_TO_FLOWDESK_SECRET`.
7. **HTTP Request → app callback**.

n8n needs `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` (or explicitly allowed env vars) so Code nodes can read the secrets. Confirmed on the pinned `n8nio/n8n:2.43.7` (Code nodes run in the task runner): `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` gives `$env` access, and `NODE_FUNCTION_ALLOW_BUILTIN=crypto` is also required for `require('crypto')`. On Webhook v2 the 202 is set under `options.responseCode`. `import:workflow` leaves workflows unpublished in regular mode (`--activeState=fromJson` needs queue mode), so `n8n-import` runs `n8n publish:workflow --id=…` after importing.

## 6. Simulated notifier (`services/notifier`)

- `POST /deliveries` (requires `Idempotency-Key`): stores `{ id, channel, message, received_at }` keyed by idempotency key; a repeated key returns the stored delivery and has no new effect.
- `GET /deliveries/:id` → 200 or 404 (used by Reconciliation).
- `GET /` → HTML list of received messages (demo view).
- `POST /admin/mode` `{ mode: "ok" | "fail" | "fail_once" | "timeout" | "accept_then_drop_callback" }`. The last mode stores the delivery but sleeps past n8n's timeout, so n8n reports failure while the effect actually happened. Reconciliation then finds it, which is the lost-response demo.
- Storage: a JSON file on a volume, so Reconciliation still works across restarts.

---

## 7. Public API

Auth: `X-API-Key` (static, from env) for external callers. The UI uses Server Actions, so it doesn't use the key.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/tickets` | Create (requires `Idempotency-Key` header) → 202 / 200 replay / 409 / 422 |
| GET | `/api/tickets` | List: `status`, `classification_state`, `category`, `priority`, `dispatch_status`, `q`, `page`, `page_size` |
| GET | `/api/tickets/:id` | Detail: classification attempts, dispatches with attempts, events |
| POST | `/api/tickets/:id/classification` | Manual classification (facts) |
| POST | `/api/tickets/:id/classification/rerun` | Re-run AI |
| POST | `/api/tickets/:id/priority-override` | `{ priority, reason }` |
| POST | `/api/tickets/:id/status` | `{ status }` |
| POST | `/api/dispatches/:id/retry` | Manual retry (409 unless `failed`) |
| POST | `/api/webhooks/n8n` | n8n callback (HMAC, no API key) |
| POST | `/api/webhooks/power-automate` | Power Automate callback (bearer secret, no API key; ADR 0011) |
| GET | `/api/requesters` | Seeded requesters |
| GET | `/api/health` | DB connectivity |

Errors use a uniform shape: `{ error: { code, message, details? } }`. The OpenAPI document is generated from the Zod schemas (`zod-openapi` or similar, only if it costs under ~1h); otherwise it's hand-written in `docs/api.md`.

## 8. Dashboard

- **/tickets**: overview counters (open, needs review, failed Dispatches, urgent), a table with filters (Ticket Status, Category, Priority, Dispatch Status) and title search.
- **/tickets/new**: form with a requester dropdown, title and description. The idempotency key is generated per form render, so a double submit yields one Ticket.
- **/tickets/[id]**: the Request, Classification (facts, Reason, source), Priority with the matched rule and the evaluation table, Team, Dispatches with their attempts, the Ticket Event timeline, and manual action controls. Auto-refreshes every 3s while anything is `pending`, `sent` or `unknown`.
- UI kit: Tailwind and shadcn/ui (optional; only if setup stays under ~30 minutes).

## 9. Configuration (`.env.example`)

```
DATABASE_URL=postgres://flowdesk:flowdesk@postgres:5432/flowdesk
FLOWDESK_API_KEY=change-me
CLASSIFIER=fake                 # fake | openai_compatible
LLM_BASE_URL=
LLM_API_KEY=
LLM_MODEL=
FAKE_CLASSIFIER_MODE=valid      # valid | invalid | timeout | provider_error
N8N_WEBHOOK_URL=http://n8n:5678/webhook/flowdesk-dispatch
FLOWDESK_TO_N8N_SECRET=change-me
N8N_TO_FLOWDESK_SECRET=change-me
NOTIFIER_URL=http://notifier:4000
DISPATCH_CALLBACK_TIMEOUT_SECONDS=60
```

## 10. Tests (Vitest, real Postgres)

| Area | Tests |
|------|-------|
| Priority Rules | table-driven: every rule, ordering, default |
| Transitions | each legal transition passes; illegal ones throw |
| Classification schema | valid, missing field, extra field, bad enum, non-JSON |
| Create Ticket | creates Ticket + event + job atomically; replay → same Ticket; same key with a different body → 409 |
| Scenario A | fake valid erp → classified → Dispatch → simulated callback succeeded → events in order |
| Scenario B | org-wide/ERP blocker → urgent, `priority_rule` recorded, route `urgent` |
| Scenario C | dispatch fails ×3 → `failed`; manual retry → new attempt, same `dispatch_id`, one Ticket, earlier attempts intact |
| Scenario D | invalid → repair → invalid → `needs_review`, no Dispatch; provider_error ×3 → `needs_review` |
| Lost response | `sent` past deadline → `unknown` → reconcile finds delivery → `succeeded`, no second delivery |
| Webhooks | bad signature → 401; stale timestamp → 401; duplicate callback → no state change |
| Worker | two workers never claim the same job; stale lease is reclaimed |

The n8n HTTP call is replaced in integration tests by a local stub that answers like n8n and posts the callback. The real n8n is exercised by `pnpm demo:e2e`, which runs against the compose stack and covers Scenarios A–D via the API and the notifier admin endpoint.

---

## 11. Delivery schedule (5 days; days 4–5 compress if needed)

Priority order from PLAN.md §9: E2E flow → real n8n integration → persistence/validation → errors/traceability → dashboard → docs.

| Day | Goal | Done when |
|-----|------|-----------|
| **1** | Foundation | Compose up with Postgres; schema + migrations + seed; createTicket with idempotency; Priority Rules + transitions with tests; job table + worker loop; fake Classifier → Ticket reaches `classified` |
| **2** | First end-to-end | Notifier service; n8n workflow imported on start; signed Dispatch + callback; OpenAI-compatible Classifier verified against the provider; minimal ticket list/detail pages. **Scenario A runs for real.** |
| **3** | Failure paths | Classification retry/repair/needs_review; dispatch auto-retry; callback deadline → unknown → Reconciliation; manual retry; Scenario B–D integration tests green |
| **4** | Dashboard | Filters/search, counters, detail timeline, priority explanation, manual classification, override, status change, retry button, auto-refresh |
| **5** | Ship | README (setup, architecture, decisions → ADRs, limitations), API docs, `pnpm demo:e2e`, demo script, polish; optional video |

### Jira tickets (Epic [SCRUM-5](https://marcosportales2002.atlassian.net/browse/SCRUM-5))

| Key | Ticket | Blocked by |
|-----|--------|------------|
| SCRUM-6 | Scaffold repo and Docker Compose stack | — |
| SCRUM-7 | Database schema, migrations and seed data | 6 |
| SCRUM-8 | Priority Rules, Team lookup and status transitions | — |
| SCRUM-9 | Submit a Request and get exactly one Ticket | 7 |
| SCRUM-10 | Background worker and Postgres job queue | 7 |
| SCRUM-11 | AI Classification (fake + OpenAI-compatible) | 8, 9, 10 |
| SCRUM-12 | Simulated notification service | 6 |
| SCRUM-13 | Dispatch to n8n + signed callback (Scenario A) | 11, 12 |
| SCRUM-14 | Dispatch failure handling + Reconciliation (Scenario C) | 13 |
| SCRUM-15 | Ticket list dashboard | 9 |
| SCRUM-16 | Ticket detail and timeline | 13 |
| SCRUM-17 | Manual Review actions | 14, 16 |
| SCRUM-18 | README, API docs, e2e smoke, demo script | 15, 17 |

**Cut line if time runs short:** OpenAPI generation (fall back to markdown), pg_trgm search (use ILIKE), shadcn (plain Tailwind), and the `accept_then_drop_callback` notifier mode (keep the plain `timeout` mode).

## 12. Demo script (≈4 minutes)

1. `docker compose up`, then open the dashboard (seeded Tickets visible).
2. **A:** submit the SAP-invoices Request → watch it go `pending → classified (urgent, rule erp_blocker) → Dispatch succeeded`; show the notifier page and the n8n execution.
3. **B:** on the same Ticket, open the priority explanation table.
4. **C:** set notifier mode `fail`, submit the data-report Request → three failed attempts → `failed`; set mode `ok` → Retry → `succeeded`. Show one Ticket with four attempts.
5. **D:** set `FAKE_CLASSIFIER_MODE=invalid` (or stop the LLM key) → Ticket in Manual Review with the raw output visible → classify manually → dispatched.
6. Close with the ADR list: "here's why it's built this way."

## 13. Known limitations (for the README)

- No real authentication: a static API key, and requesters are selected from seed data.
- Reconciliation depends on the target exposing a lookup by idempotency key; the simulated notifier does, real systems may not.
- Single worker process is assumed for the demo, though the claim logic is safe for several.
- No semantic duplicate detection (two people reporting the same outage).
- LLM self-reported reasoning is shown for explanation only; it is not trusted for decisions.

## 14. Future improvements (out of scope)

Semantic duplicate linking, real SSO, SAP/ERP connector, Data Warehouse export of Ticket Events, SLA timers, Team assignment to individuals, real chat channels (Slack/Teams) as additional n8n branches.
