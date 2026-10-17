# flow-desk-ai

## Quick start

```sh
cp .env.example .env
docker compose up
```

- App: http://localhost:3000 (`GET /api/health` checks DB connectivity)
- n8n: http://localhost:5678
- Notifier: http://localhost:4000 (received-messages page)

Host ports can be overridden in `.env` (`APP_HOST_PORT`, `N8N_HOST_PORT`, `NOTIFIER_HOST_PORT`, `POSTGRES_HOST_PORT`).

## Simulated notifier

`services/notifier` stands in for the external notification target. Deliveries are stored in a JSON file on the `notifier-data` volume.

- `POST /deliveries` with an `Idempotency-Key` header and `{ "channel", "message" }`: `201` on first receipt; a repeated key returns the stored delivery with `200` and no new effect.
- `GET /deliveries/:id`: `200` or `404` (used by Reconciliation).
- `GET /`: HTML list of received messages.
- `POST /admin/mode` with `{ "mode": "…" }` (`GET` shows the current mode). The mode is not persisted, so a restart puts it back to `ok`. It applies to new keys only; a repeated key always gets its stored delivery.

| Mode | Effect on a new delivery |
|------|--------------------------|
| `ok` | stored, `201` |
| `fail` | not stored, `500` |
| `fail_once` | not stored, `500`, then back to `ok` |
| `timeout` | not stored, held past n8n's 10s timeout, then `504` |
| `accept_then_drop_callback` | stored, but the `201` comes only after n8n's timeout: the lost-response case |

Slow modes hold the request for `SLOW_RESPONSE_MS` (default 15000).

```sh
curl -X POST localhost:4000/admin/mode -H 'content-type: application/json' -d '{"mode":"fail_once"}'
```

## Classification

The worker classifies each Ticket with the Classifier chosen by `CLASSIFIER`:

- `fake` (default): deterministic and key-less. `FAKE_CLASSIFIER_MODE` is `valid` (keyword rules for the example Requests), `invalid`, `timeout` or `provider_error`, to exercise the failure paths.
- `openai_compatible`: any OpenAI-compatible chat completions API. Set `LLM_BASE_URL` (including `/v1`), `LLM_API_KEY` and `LLM_MODEL`. It asks for `json_schema`, falls back to `json_object`, then to plain JSON; the reply is always Zod-validated.

Invalid output gets one repair call, then the Ticket goes to `needs_review`. Provider errors get 3 attempts in total (waiting 2s, then 8s between them), then `needs_review`. Neither creates a Dispatch.

### Smoke test against the real provider

```sh
# .env: CLASSIFIER=openai_compatible, LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
docker compose up -d --build worker app
curl -s -X POST localhost:3000/api/tickets \
  -H "X-API-Key: $FLOWDESK_API_KEY" \
  -H "Idempotency-Key: smoke-1" -H "Content-Type: application/json" \
  -d '{"requesterId":"<id from GET /api/requesters>","title":"SAP unreachable","description":"I haven'"'"'t been able to access SAP since this morning, and I need to process some invoices."}'
docker compose exec postgres psql -U flowdesk flowdesk -c \
  "select kind, outcome, model, error from classification_attempts order by created_at desc limit 3"
```

Expect `classified`, category `erp`, priority `urgent` (rule `erp_blocker`) on the Ticket. The `response_format` the provider accepts is not verified yet (it needs credentials): check which attempt succeeded in the worker logs and record it here.

## Development

```sh
pnpm install
docker compose up -d postgres   # tests run against the flowdesk_test database
pnpm test
pnpm typecheck && pnpm lint
```

The compose `migrate` step applies migrations and loads idempotent demo data (`pnpm db:migrate && pnpm db:seed`). After changing `src/infra/db/schema.ts`, run `pnpm db:generate` to add a migration. The test run drops and re-migrates `flowdesk_test` from scratch.
