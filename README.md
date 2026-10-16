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
