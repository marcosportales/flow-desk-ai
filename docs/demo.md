# Demo script (about 4 minutes)

Setup, once: `cp .env.example .env && docker compose up -d`, then confirm `pnpm demo:e2e` passes (it runs the same four scenarios below, headless). Keep four tabs open: the dashboard (<http://localhost:3000/tickets>), the notifier page (<http://localhost:4000>), the simulated ERP page (<http://localhost:4100>) and n8n executions (<http://localhost:5678>; create the owner account on first visit). On a stack started before the ERP existed, load the updated workflow first (README, "Dispatch").

Notifier and ERP modes are switched with:

```sh
curl -X POST localhost:4000/admin/mode -H 'content-type: application/json' -d '{"mode":"fail"}'   # notifier; or "ok"
curl -X POST localhost:4100/admin/mode -H 'content-type: application/json' -d '{"mode":"fail"}'   # ERP
```

## 1. Orientation (30 s)

Open `/tickets`: seeded fictional Tickets, counters, filters. A User in a Team (for example Grace Lindqvist, `it_systems`) lands on the **Team queue** and can switch to **My requests**; a User in no Team (for example Ana Morales) sees only what they raised. One sentence on the idea: _the AI extracts facts, deterministic rules decide Priority and Team, n8n executes, the app records everything_ ([ADR 0001](adr/0001-ai-extracts-facts-rules-decide.md), [0005](adr/0005-app-decides-n8n-executes.md)).

## 2. Scenario A, successful workflow (60 s)

Sign in at `/sign-in` with "Sign in as Ana Morales" (or any seeded User), then `/tickets/new` → title "SAP unreachable", description "I haven't been able to access SAP since this morning, and I need to process some invoices." → submit. Ana is the Requester only, so her detail page is read-only: there is no Manual actions section.

The detail page refreshes itself: classified (`erp`, blocks work), Priority **urgent** by rule `erp_blocker`, Team `it_systems`, Dispatch `pending → sent → succeeded`. An `erp` Ticket is not a chat message: n8n's `erp` branch creates an incident in the simulated ERP, and the ERP's incident number comes back as the **External Reference** (for example `INC-000001`), shown in the detail header and in the list's External Reference column. Show the ERP page (the incident, keyed by the `dispatch_id`) and the matching n8n execution. FlowDesk stays the intake layer in front of the ERP, which remains the system of record ([ADR 0009](adr/0009-flowdesk-is-a-layer-in-front-of-the-erp.md)).

## 3. Scenario B, why was it urgent? (30 s)

Same Ticket: open the priority explanation table. Every rule is listed with whether it matched; the first match wins and is stored on the Ticket. The AI's Reason is shown separately and is never used for the decision.

## 4. Scenario C, integration failure (60 s)

Sign in as Ana Morales, set notifier mode `fail` and submit "The monthly sales report shows incorrect data for the last quarter." Watch the failed attempts, then Dispatch `failed`; the Ticket is stored and classified. Set mode `ok`, sign out and sign in as **Ines Duarte** (`data_team`, so an Operator of this Ticket; it is in her Team queue) and press **Retry** in Manual actions. The Dispatch succeeds: one Ticket, one `dispatch_id`, the failures still on the timeline. The notifier receives the message once because the `dispatch_id` is the idempotency key end to end ([ADR 0006](adr/0006-reconcile-before-retry.md)).

Optional, if time allows: mode `accept_then_drop_callback` is the lost-response case. The delivery happens but the answer arrives too late; the Dispatch goes `unknown`, Reconciliation asks the notifier, finds the delivery and settles it without sending again. The same works on the ERP: set its mode to `accept_then_drop_callback` and submit an SAP Request. The incident is created but n8n gives up waiting; after `DISPATCH_CALLBACK_TIMEOUT_SECONDS` Reconciliation asks the ERP, finds the incident, settles the Dispatch and stores its External Reference. The ERP page still shows a single incident.

## 5. Scenario D, invalid AI output (45 s)

Set `FAKE_CLASSIFIER_MODE=invalid` in `.env` and run `docker compose up -d worker`. Submit any Request as Ana Morales. After the repair attempt the Ticket lands in **needs review** with the raw output visible and no Dispatch created. A Ticket with no Category belongs to `service_desk` (ADR 0008), so sign in as **Jonas Weber** (`service_desk`), open it from the Team queue and enter a classification by hand: rules recompute, the Ticket is dispatched. Afterwards set the mode back to `valid` in `.env` and run `docker compose up -d worker` again; the worker keeps the old setting until it is recreated.

## 6. Close (15 s)

Show the ADR list in the README: "here is why it is built this way", and the limitations section: "here is what I would do next".
