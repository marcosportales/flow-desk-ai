# Power Automate is an alternative Workflow Engine, chosen per deployment

Each deployment sends every Dispatch to one Workflow Engine, n8n or Power Automate, selected by configuration. Both engines get the same event and return the same callback, so ADR 0005 holds for either. n8n stays the default because it runs entirely under `docker compose up` (ADR 0002). Power Automate is optional: it needs a Microsoft tenant with Premium connectors and a tunnel, since a cloud service cannot reach local services. We rejected routing per Team or Category, and sending to both engines, because either one would give a Dispatch more than one outcome to track.

## Consequences

- Power Automate cannot compute HMAC natively. Its inbound side relies on the signed trigger URL (`sig`) kept as a secret, and its callback uses a bearer secret on its own route. This is weaker than n8n's HMAC, and we accept it for an optional engine.
- Teams cannot answer "did you receive this id?", so the flow still records each delivery in the notifier, which keeps Reconciliation as in ADR 0006. The flow checks the notifier first, then posts to Teams, then records the delivery. A crash between the post and the record can cause one duplicate Teams message on retry. We prefer that over a lost notification.
- Both callback routes stay active, and each Dispatch Attempt records the Workflow Engine that ran it, so switching engines while Dispatches are in flight is safe.
