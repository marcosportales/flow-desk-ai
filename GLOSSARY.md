# FlowDesk AI

Turns internal business requests into structured, traceable Tickets: an AI reads each one, deterministic rules decide what it means for priority and routing, and automated workflows act on it.

## Intake

**Request**:
The raw text (title and description) a Requester submits. It is preserved verbatim and never rewritten.
_Avoid_: Submission, message

**Ticket**:
The record created the moment a Request arrives, before any AI processing. Everything that happens afterwards is attached to a Ticket; a Ticket can exist without ever being classified.
_Avoid_: Case, issue, incident (as the name of the record)

**Requester**:
The employee on whose behalf a Request is submitted. In the demo, one of a fixed set of fictional people.
_Avoid_: User, customer, reporter

**Duplicate Submission**:
The same Request arriving more than once (double click, client retry, lost response). It must yield one Ticket. Two different Requests describing the same problem are *not* Duplicate Submissions.
_Avoid_: Duplicate ticket (ambiguous)

## Classification

**Classification**:
The facts an AI extracts from a Request: Category, Summary, whether it blocks work, Impact Scope, and a short Reason. A Classification describes the Request; it does not decide anything.
_Avoid_: AI decision, prediction

**Category**:
One of a fixed set of kinds of Request (for example ERP, access, data, inquiry, other). Determines the Team.
_Avoid_: Type, topic

**Inquiry**:
A Request asking about the state of an earlier Ticket rather than reporting a new problem. Always goes to Manual Review.
_Avoid_: Follow-up, status request

**Impact Scope**:
How many people a problem affects: an individual, a team, or the whole organization.
_Avoid_: Severity, blast radius

## Decisions

**Priority**:
The final urgency of a Ticket, computed only by Priority Rules from the Classification. Never taken directly from the AI.
_Avoid_: Severity, suggested priority

**Priority Rule**:
A named, deterministic rule that maps Classification facts to a Priority. The rules that fired are recorded on the Ticket so the Priority can be explained.
_Avoid_: Heuristic, policy

**Team**:
The group responsible for a Ticket, looked up from its Category in a fixed table.
_Avoid_: Assignee, queue, suggested team

**Ticket Status**:
Where a Ticket is in its human lifecycle: open, resolved or closed. Independent of whether classification or automation succeeded.
_Avoid_: State (unqualified), processing status

**Classification State**:
Whether a Ticket has a usable Classification yet: pending, classified, or in Manual Review.
_Avoid_: AI status

**Priority Override**:
A human replacing the rule-computed Priority on a Ticket, always with a written reason. Recorded alongside the Priority it replaced.
_Avoid_: Manual priority, escalation

**Manual Review**:
The state of a Ticket that needs a human to classify or confirm it before any automated action runs: because the AI failed, produced invalid output, or the Request is an Inquiry.
_Avoid_: Triage, fallback

## Automation

**Dispatch**:
The act of handing a classified Ticket's routing decision (Category, Priority, Team) to the workflow engine so it performs an action, such as notifying a Team. Has its own Dispatch Status, separate from the Ticket Status.
_Avoid_: Trigger, notification (for the act itself), webhook call

**Dispatch Status**:
The outcome of a Dispatch as far as the system knows: pending, sent, succeeded, failed, or unknown.
_Avoid_: Notification status

**Unknown (Dispatch)**:
A Dispatch that was sent but whose outcome never came back. It may or may not have had its effect, so it must be checked before being repeated.
_Avoid_: Timed out, lost

**Urgent Route**:
The workflow branch taken for Tickets whose Priority is urgent.
_Avoid_: Escalation path, fast lane

**Dispatch Attempt**:
One try at carrying out a Dispatch. A Dispatch may have several; earlier Attempts are never altered or removed.
_Avoid_: Retry (as a noun for the record), execution

**Reconciliation**:
Asking the target system whether an Unknown Dispatch actually took effect, before deciding whether it may be retried.
_Avoid_: Status check, verification

## History

**Ticket Event**:
An entry in a Ticket's timeline recording one thing that happened to it (created, classified, Priority Rule fired, dispatched, failed, retried, overridden). Ticket Events are only ever appended.
_Avoid_: Log, audit entry, activity
