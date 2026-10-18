---
name: verify
description: Prove a change works in the running app before opening a PR. Rebuilds a compose stack from your checkout, runs the CI commands and `pnpm demo:e2e`, then walks the story's acceptance criteria in the browser as the Requester and the Operator through the Playwright MCP. Use before opening a PR, or when asked to verify, smoke-test or check a change in the UI.
---

Green tests are the floor; the proof is the story's acceptance criteria observed in the browser by the Users they are about. Work through the steps in order. A step that fails stops the run: fix the change, then start again from the `build` in step 2.

## 1. List the acceptance criteria

Fetch the Jira issue (`docs/agents/issue-tracker.md`) and read the spec section it points to, usually `docs/specs/<spec>.md` § T<n>, "**Accepted when:**". Break that line into a checklist of **observations**: who is signed in, which page, which action, what appears. Prohibitions count too ("only their own Ticket", "every other Manual Action stays forbidden"), and each one needs two observations: the control is absent in the UI, and the server refuses the request.

Done when every clause of "Accepted when" maps to at least one observation.

## 2. Start your own stack

`docker-compose.yml` pins `name: flowdesk`, and the user usually has that stack running from the main checkout. Run yours under its own project name and host ports, built from your checkout, with every setting in `.env`: shell variables do not survive between your Bash calls, and `.env` is read by every `docker compose` command and by `pnpm demo:e2e`.

```sh
test -f .env || cp .env.example .env           # a worktree has no .env
```

Set these in `.env`, replacing any existing line for the same key (keep `DEMO_SIGN_IN=on`; the sign-in shortcuts need it):

```sh
COMPOSE_PROJECT_NAME=flowdesk-verify           # overrides the pinned name for every command below
APP_HOST_PORT=3100
N8N_HOST_PORT=5780
NOTIFIER_HOST_PORT=4010
ERP_HOST_PORT=4110
POSTGRES_HOST_PORT=5433
BETTER_AUTH_URL=http://localhost:3100          # must match the app's URL, or sign-in POSTs are refused
CLASSIFIER=fake                                # the user's .env may point at a real LLM
FAKE_CLASSIFIER_MODE=valid
```

`demo:e2e` Scenario D and the Team routing in step 4 rely on the deterministic fake Classifier.

```sh
docker compose config --format json | jq -r .name   # must print flowdesk-verify before you run anything else
docker compose build app notifier erp          # every run: without it the containers run the image's old code
docker compose up -d --wait
```

Build through `app` alone: `app`, `migrate` and `worker` share the image `flowdesk-app`, and `up --build` builds it three times in parallel, which fails with `image "flowdesk-app:latest": already exists`. The tag is shared with the user's stack too, so after your build their next recreate runs your branch's code; step 5 tells them. The `migrate` service applies the migrations and the seed on the way up.

Done when `docker compose up --wait` exits 0, `docker compose ps -a` shows `migrate` exited 0, and `curl -s localhost:3100/api/health` answers 200.

## 3. Run the checks

```sh
pnpm install --frozen-lockfile
pnpm format:check && pnpm lint && pnpm typecheck
TEST_DATABASE_URL=postgres://flowdesk:flowdesk@localhost:5433/flowdesk_test pnpm test
pnpm demo:e2e                                  # about two minutes; reads the host ports from .env
```

These are the four CI commands (`.github/workflows/ci.yml`), plus the live check against the real n8n.

Done when every command exits 0.

## 4. Walk the criteria in the browser

Drive `http://localhost:3100` with the Playwright MCP (`mcp__playwright__browser_*`). Read pages with `browser_snapshot`, and wait on text with `browser_wait_for` rather than sleeping: the Ticket detail page refreshes itself while classification and the Dispatch run in the background.

**Sign in** at `/sign-in` with "Sign in as <name>"; switch Users with **Sign out** in the header.

| User            | Capacity                                             |
| --------------- | ---------------------------------------------------- |
| Ana Morales     | Requester only: in no Team                           |
| Kofi Mensah     | Operator of `it_systems` and `data_team` Tickets     |
| Ines Duarte     | Operator of `data_team` Tickets                      |
| Grace Lindqvist | Operator of `it_systems` Tickets                     |
| Jonas Weber     | Operator of `service_desk` Tickets (no Category yet) |

Operator is a capacity on a Ticket, given by its Team (ADR 0008), so pick a Request whose Team you know. With the default fake Classifier, "The monthly sales report shows incorrect data for the last quarter." lands in `data_team` (Kofi or Ines) and "I haven't been able to access SAP since this morning, and I need to process some invoices." lands in `it_systems` as an urgent `erp` Ticket. Create Tickets at `/tickets/new` as the Requester; the page stays put and shows "Ticket #n created" with a **View ticket** link.

The sign-in page lists more Requester-only Users (Ben Okafor, Elena Rossi, …) who raised the seeded Tickets. For "not their own Ticket", take one of theirs: `docker compose exec -T postgres psql -U flowdesk flowdesk -c "select t.id, t.status, u.name from tickets t join users u on u.id = t.requester_id"`. Its page is `404` to any other Requester.

What each User sees on `/tickets/[id]`:

- An Operator of the Ticket's Team gets **Manual actions**.
- A Requester-only User gets no Manual actions. While the Ticket is `resolved`, and only then, they get **Is it fixed?**: Close Ticket ("It's fixed") or Reopen Ticket ("It's still broken"), each with a Reason.
- Ticket Status moves `open → resolved → closed | open`, so a walk that reopens and then closes needs the Operator to resolve the Ticket again in between.
- Every action appears in the **Timeline** with its actor's name.

To see the server refuse a forbidden action, call its route from the page as the signed-in User with `browser_evaluate` and `fetch`, so the session cookie goes along. The routes and bodies are in `docs/api.md`; expect `403`, or `409` for an illegal transition.

For each observation, take a `browser_take_screenshot`; screenshots land in `.playwright-mcp/`.

Done when every observation from step 1 is checked off against what the snapshot showed. An observation that does not hold is a failure, not a note.

## 5. Report and tear down

Put a **Verified** section in the PR body: the commands from step 3 with their result, then each acceptance criterion with the User, the page and what was observed.

```sh
docker compose config --format json | jq -r .name   # flowdesk-verify, or stop: down -v deletes that project's volumes
docker compose down -v
```

Tell the user that the `flowdesk-app` image now holds your branch's build, and that `docker compose build app` in the main checkout restores theirs.

Done when the PR body has the Verified section, `docker compose ls` no longer lists `flowdesk-verify`, and the user has been told about the image.
