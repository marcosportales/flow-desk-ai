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

## Development

```sh
pnpm install
docker compose up -d postgres   # tests run against the flowdesk_test database
pnpm test
pnpm typecheck && pnpm lint
```

The compose `migrate` step applies migrations and loads idempotent demo data (`pnpm db:migrate && pnpm db:seed`). After changing `src/infra/db/schema.ts`, run `pnpm db:generate` to add a migration. The test run drops and re-migrates `flowdesk_test` from scratch.
