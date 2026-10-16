# Local-first, long-running deployment via Docker Compose

The whole system (web app, Postgres, n8n) runs with `docker compose up`, and the same compose file is the path to any public demo (for example a single VPS). We rejected serverless hosting (for example Vercel with managed Postgres) because reliable background processing, retries and recovery from lost responses need a long-running process, and the project must be reproducible by an evaluator with no cloud accounts.
