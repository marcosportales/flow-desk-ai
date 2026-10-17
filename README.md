# flow-desk-ai

## Quick start

```sh
cp .env.example .env
docker compose up
```

- App: http://localhost:3000 (`GET /api/health` checks DB connectivity)
- n8n: http://localhost:5678
- Notifier: http://localhost:4000

Host ports can be overridden in `.env` (`APP_HOST_PORT`, `N8N_HOST_PORT`, `NOTIFIER_HOST_PORT`, `POSTGRES_HOST_PORT`).

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
