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

## Development

```sh
pnpm install
docker compose up -d postgres   # tests run against the flowdesk_test database
pnpm test
pnpm typecheck && pnpm lint
```

The compose `migrate` step applies migrations and loads idempotent demo data (`pnpm db:migrate && pnpm db:seed`). After changing `src/infra/db/schema.ts`, run `pnpm db:generate` to add a migration. The test run drops and re-migrates `flowdesk_test` from scratch.
