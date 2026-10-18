# API

The public API is hand-written here rather than generated from the Zod schemas; the schemas in `src/` stay the source of truth for validation (`createTicketInput`, `Classification`, `listTicketsQuery`, `DispatchCallback`).

Base URL: `http://localhost:3000` (override with `APP_HOST_PORT`).

## Conventions

- **Auth**: every endpoint except `/api/health` and `/api/webhooks/n8n` needs `X-API-Key: $FLOWDESK_API_KEY`, except the Manual Action routes below. A missing or wrong key is `401 unauthorized`. The API key identifies an Integration: it can create, read and list Tickets but not run Manual Actions.
- **Manual Actions** (`/api/tickets/:id/classification`, `…/classification/rerun`, `…/priority-override`, `…/status`, `…/take`, `…/release`, `…/reassign`, `/api/dispatches/:id/retry`) take an Operator session cookie (ADR 0008) and refuse the API key with `403 forbidden`. No session is `401`; a signed-in User who is not an Operator of the Ticket's Team is `403 forbidden`. The web UI uses Server Actions and a Better Auth session cookie (sign in at `/sign-in`), not the key; `/api/auth/*` and `/api/demo-sign-in` are the sign-in endpoints.
- **The Requester's answer** (`/api/tickets/:id/requester-status`) takes the session cookie of the Ticket's Requester and refuses the API key with `403 forbidden`. No session is `401`; any other User is `403 forbidden`.
- **Errors** always have the same shape: `{ "error": { "code": "...", "message": "...", "details": ... } }` (`details` only for validation errors, as Zod's flattened error).
- **Ids** are UUIDs; a malformed id is `404 not_found`.
- **Bodies** are JSON; invalid JSON is `422 validation_error`.

| Status | `error.code`                                      | Meaning                                                         |
| ------ | ------------------------------------------------- | --------------------------------------------------------------- |
| 401    | `unauthorized`                                    | Missing or invalid API key                                      |
| 401    | `invalid_signature`, `stale_timestamp`            | Bad HMAC or timestamp skew over 5 minutes (callback only)       |
| 403    | `forbidden`                                       | Manual Action without an Operator session of the Ticket's Team, or the Requester's answer without the Requester's session |
| 404    | `not_found`                                       | Unknown Ticket or Dispatch                                      |
| 409    | `idempotency_conflict`                            | Idempotency-Key reused with a different request                 |
| 409    | `conflict`, `illegal_transition`, `not_retryable` | The Ticket or Dispatch is not in a state that allows the action |
| 422    | `validation_error`                                | Invalid body, query or header                                   |

## Endpoints

### `POST /api/tickets`

Submit a Request. Requires an `Idempotency-Key` header (1–255 chars); the same key with the same body returns the same Ticket.

```json
{
  "requesterId": "<uuid>",
  "title": "SAP unreachable",
  "description": "I haven't been able to access SAP since this morning…"
}
```

`title` is 3–200 characters, `description` 10–5000. Responses: `202 { "ticket": {…} }` on creation, `200` on a replay, `409 idempotency_conflict`, `422`. The Ticket is returned unclassified; the worker classifies it in the background.

```sh
curl -X POST localhost:3000/api/tickets \
  -H "X-API-Key: $FLOWDESK_API_KEY" -H "Idempotency-Key: demo-1" -H "Content-Type: application/json" \
  -d '{"requesterId":"<id>","title":"SAP unreachable","description":"I cannot access SAP and need to process invoices."}'
```

### `GET /api/tickets`

List Tickets, newest first. Query parameters (all optional, empty values are ignored):

| Param                  | Values                                              |
| ---------------------- | --------------------------------------------------- |
| `status`               | `open`, `resolved`, `closed`                        |
| `classification_state` | `pending`, `classified`, `needs_review`             |
| `category`             | `erp`, `access`, `data`, `inquiry`, `other`         |
| `priority`             | `urgent`, `high`, `normal`, `low`                   |
| `assignee`             | `unassigned`, `mine` (`mine` needs a session)       |
| `dispatch_status`      | `pending`, `sent`, `succeeded`, `failed`, `unknown` |
| `q`                    | Title search (max 200 chars)                        |
| `page`, `page_size`    | Default page size 25, maximum 100                   |

Response: `{ "tickets": [...], "total": n, "page": n, "pageSize": n }`.

### `GET /api/tickets/:id`

Everything about one Ticket: `ticket`, `requester`, `assignee` (`{ id, name }` or `null`), `classificationAttempts` (with `rawOutput` for invalid outputs), `dispatches` (each with its `attempts`), `events` (the timeline, oldest first), `priorityEvaluation` (the rule table as recorded), `reason` (the AI's explanation), and `settled` (false while classification or a Dispatch is still in flight).

### `POST /api/tickets/:id/classification`

Manual classification, allowed on `needs_review` or `classified` Tickets. Body is the Classification:

```json
{
  "category": "data",
  "summary": "…",
  "blocks_work": false,
  "impact_scope": "individual",
  "reason": "…"
}
```

`category` is `erp | access | data | inquiry | other`; `impact_scope` is `individual | team | organization`; `summary` ≤ 200 and `reason` ≤ 500 characters; no extra keys. Priority and Team are recomputed by the rules, and a new Dispatch is created if the routing changed. `200 { "ticketId" }`, `403`, `404`, `409`, `422`.

### `POST /api/tickets/:id/classification/rerun`

Queue another AI classification of a `needs_review` Ticket. No body. `202 { "ticketId" }`, `403`, `409` if not re-runnable or already queued.

### `POST /api/tickets/:id/priority-override`

`{ "priority": "urgent|high|normal|low", "reason": "…" }` (reason 1–500 characters, required). Allowed on `classified` Tickets; a changed Route creates a new Dispatch. `200`, `403`, `404`, `409`, `422`.

### `POST /api/tickets/:id/status`

`{ "status": "open|resolved|closed" }`. Legal moves: open→resolved, resolved→closed, resolved→open. It records an event only and never touches Dispatches. `200`, `403`, `404`, `409 illegal_transition`, `422`.

### `POST /api/tickets/:id/requester-status`

The Requester's answer to a `resolved` Ticket: `{ "response": "close|reopen", "reason": "…" }` (reason 1–500 characters, required). `close` moves it to `closed`, `reopen` back to `open`; the reason is recorded in the timeline under the Requester's name. `200 { "ticketId" }`, `401`, `403`, `404`, `409 illegal_transition`, `422`.

### `POST /api/tickets/:id/take`

An Operator of the Ticket's Team becomes its Assignee. No body. Atomic: when two Operators take at once, one gets `200` and the other `409 conflict` ("Another Operator already took this Ticket"). `200`, `403`, `404`, `409`.

### `POST /api/tickets/:id/release`

Clears the Assignee. Any Operator of the Team may release (ADR 0008). No body. `200`, `403`, `404`, `409` when the Ticket has no Assignee.

### `POST /api/tickets/:id/reassign`

`{ "assigneeId": "<user uuid>" }`. The new Assignee must be a member of the Ticket's Team. `200`, `403`, `404`, `409` when already assigned to that User, `422` for a malformed id or a User outside the Team.

### `POST /api/dispatches/:id/retry`

Manual retry of a `failed` Dispatch: same `dispatch_id`, new attempt. `202 { "dispatchId", "status": "pending" }`, `403`, `404`, `409 not_retryable` for any other status.

### `POST /api/webhooks/n8n`

n8n's callback. No API key; authenticated by `X-FlowDesk-Timestamp` and `X-FlowDesk-Signature: sha256=HMAC(N8N_TO_FLOWDESK_SECRET, timestamp + "." + body)`.

```json
{
  "dispatch_id": "<uuid>",
  "outcome": "succeeded",
  "n8n_execution_id": "42",
  "error": null,
  "delivered_at": "2026-10-17T10:00:00Z",
  "external_reference": "INC-000001"
}
```

`outcome` is `succeeded | failed`. `external_reference` is optional: the id the target system gave its record (the simulated ERP's incident number). On `succeeded` it is stored on the Ticket as `externalReference`, which `GET /api/tickets` and `GET /api/tickets/:id` return. Idempotent: a callback for an already-settled Dispatch is recorded on the timeline and changes nothing. `401` on a bad signature or stale timestamp, `422` on an invalid body.

### `GET /api/requesters`

The seeded fictional Users: `{ "requesters": [{ "id", "name", "department" }] }`.

### `GET /api/health`

No auth. `200 { "status": "ok", "database": "up" }`, or `503 { "status": "error", "database": "down" }`.
