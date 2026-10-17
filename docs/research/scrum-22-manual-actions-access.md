# SCRUM-22: Should the Requester have access to the Manual Actions panel?

## Conclusion

**Restrict, don't keep as-is.** Every Manual Action is an operator/triage control, not a Requester one. The Requester should get a read-only Ticket page. But the app has no identity or roles today, so the restriction cannot be enforced yet: do it as a small UI split now, and defer real enforcement until authentication exists.

## What the panel exposes today

Source: `src/app/tickets/[id]/ManualActions.tsx`, `actions.ts`, rendered unconditionally from `page.tsx` ("Manual actions" section).

| Action | Shown when | Who should perform it |
| --- | --- | --- |
| Re-run AI | Classification needs review | Operator: retries a system process |
| Classify manually | needs_review or classified | Operator: overrides the AI's facts (Category, Impact Scope, blocks work) |
| Priority Override | classified | Operator: Priority is meant to be computed only by Priority Rules (ADR-0001); an override is a triage decision |
| Ticket Status (open/resolved/closed) | always | Operator, mostly. Resolving or closing is the Team's call |
| Retry Dispatch | latest Dispatch failed | Operator: infrastructure concern (ADR-0006) |

Today nobody is authenticated: the page is open to anyone, and the Requester is just a seed-data pick (`README.md`: "No real authentication"; `PLAN.md` lists "complex roles and permissions system" as out of scope). So "who executes them" is by convention the operator/agent, not enforced.

## Findings

1. **Four of five actions are unusable by a Requester.** Classification, Priority and Dispatch are internal decision/automation concepts the Requester doesn't know about. Letting them edit Category or Priority lets a Requester inflate their own Priority, which defeats ADR-0001 (rules decide).
2. **Ticket Status is the only arguable one.** A Requester closing or reopening their own ticket ("it's fixed now" / "still broken") is a normal helpdesk feature. It should be a separate, narrower control, not the operator's full status select.
3. **Visibility is a separate question from execution.** Read-only information (classification summary, priority and the rules that fired, dispatch history) is already shown in other page sections and is useful for the Requester's traceability. Only the *controls* need hiding.
4. **Enforcement gap.** Hiding the panel is cosmetic: the Server Actions in `actions.ts` and the API routes under `/api/tickets/[id]/*` have no role check. Real restriction needs identity first (out of scope per PLAN.md).

## Recommendation

- **Now (no auth needed):** treat the panel as the *operator view*. Move it behind a separate route or toggle (e.g. `/tickets/[id]?view=operator`, or `/operator/tickets/[id]`) and make the default Ticket page read-only for the Requester. Optionally add a Requester "Close my ticket" control.
- **Later (with auth):** derive the view from a role (`requester` / `operator`) and add the same check in each Server Action and API route. Until then, document that the operator view is not a security boundary.
- **Domain:** add **Operator** to `GLOSSARY.md` (the person who triages and acts on Tickets) and keep **Requester** distinct. This ticket's wording ("usuario final") maps to Requester.

## Impact on the current flow

Ticket creation (`/tickets/new`) is unaffected. The detail page loses the Manual actions section for the Requester; the demo script (`docs/demo.md`) and `scripts/demo-e2e.ts` scenarios that use Manual Review must point to the operator view. API routes and tests are unaffected by the UI split.

## Suggested follow-up tickets

1. **Story:** Split Ticket detail into Requester (read-only) and Operator (Manual Actions) views. Update `docs/demo.md`.
2. **Task:** Add Operator to `GLOSSARY.md`.
3. **Story (optional):** Requester can close/reopen their own Ticket with a restricted status control.
4. **Story (blocked on auth):** Role-based authorization on Server Actions and API routes.
