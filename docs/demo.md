# Demo script (about 4 minutes)

Setup, once: `cp .env.example .env && docker compose up -d`, then confirm `pnpm demo:e2e` passes (it runs the same four scenarios below, headless). Keep three tabs open: the dashboard (<http://localhost:3000/tickets>), the notifier page (<http://localhost:4000>) and n8n executions (<http://localhost:5678>; create the owner account on first visit).

Notifier mode is switched with:

```sh
curl -X POST localhost:4000/admin/mode -H 'content-type: application/json' -d '{"mode":"fail"}'   # or "ok"
```

## 1. Orientation (30 s)

Open `/tickets`: seeded fictional Tickets, counters, filters. One sentence on the idea: _the AI extracts facts, deterministic rules decide Priority and Team, n8n executes, the app records everything_ ([ADR 0001](adr/0001-ai-extracts-facts-rules-decide.md), [0005](adr/0005-app-decides-n8n-executes.md)).

## 2. Scenario A, successful workflow (60 s)

Sign in at `/sign-in` with "Sign in as Ana Morales" (or any seeded User), then `/tickets/new` → title "SAP unreachable", description "I haven't been able to access SAP since this morning, and I need to process some invoices." → submit.

The detail page refreshes itself: classified (`erp`, blocks work), Priority **urgent** by rule `erp_blocker`, Team `it_systems`, Dispatch `pending → sent → succeeded`. Show the notifier page (message prefixed `[URGENT]`) and the matching n8n execution.

## 3. Scenario B, why was it urgent? (30 s)

Same Ticket: open the priority explanation table. Every rule is listed with whether it matched; the first match wins and is stored on the Ticket. The AI's Reason is shown separately and is never used for the decision.

## 4. Scenario C, integration failure (60 s)

Set notifier mode `fail`. Submit "The monthly sales report shows incorrect data for the last quarter." Watch the failed attempts, then Dispatch `failed`; the Ticket is stored and classified. Set mode `ok` and press **Retry**. The Dispatch succeeds: one Ticket, one `dispatch_id`, the failures still on the timeline. The notifier receives the message once because the `dispatch_id` is the idempotency key end to end ([ADR 0006](adr/0006-reconcile-before-retry.md)).

Optional, if time allows: mode `accept_then_drop_callback` is the lost-response case. The delivery happens but the answer arrives too late; the Dispatch goes `unknown`, Reconciliation asks the notifier, finds the delivery and settles it without sending again.

## 5. Scenario D, invalid AI output (45 s)

Set `FAKE_CLASSIFIER_MODE=invalid` in `.env` and run `docker compose up -d worker`. Submit any Request. After the repair attempt the Ticket lands in **needs review** with the raw output visible and no Dispatch created. Enter a classification by hand: rules recompute, the Ticket is dispatched. Afterwards set the mode back to `valid` in `.env` and run `docker compose up -d worker` again; the worker keeps the old setting until it is recreated.

## 6. Close (15 s)

Show the ADR list in the README: "here is why it is built this way", and the limitations section: "here is what I would do next".
