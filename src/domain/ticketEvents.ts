import { z } from "zod";
import {
  Classification,
  classificationAttemptKinds,
  classificationOutcomes,
} from "./classification";
import { priorities, priorityRuleNames } from "./priority";
import { routes, teams } from "./routing";
import { dispatchStatuses, ticketStatuses } from "./transitions";

// Ticket Events and the `data` each type carries: docs/plan/IMPLEMENTATION.md
// §3. The `ticket_events` columns take their types from here, so an event of
// an unknown type, or with data shaped for another type, does not compile.

const event = <T extends string, D extends z.ZodType>(type: T, data: D) =>
  z.strictObject({ type: z.literal(type), data });

const priority = z.enum(priorities);
const ticketStatus = z.enum(ticketStatuses);

const PriorityEvaluation = z.strictObject({
  priority,
  rule: z.enum(priorityRuleNames),
  evaluated: z.array(
    z.strictObject({
      rule: z.enum(priorityRuleNames),
      priority,
      matched: z.boolean(),
    }),
  ),
});

// The Workflow Engine's callback for a Dispatch, as recorded on the event it
// settles.
const callbackFields = {
  dispatchId: z.uuid(),
  deliveredAt: z.string().nullable(),
  error: z.string().nullable(),
};

// Two variants of `fields` plus the Execution Reference: as written now, and
// as `n8nExecutionId`, the name it had before. Events are never rewritten, so
// both must keep parsing.
const withExecutionReference = <F extends z.ZodRawShape>(fields: F) =>
  [
    z.strictObject({ ...fields, executionReference: z.string() }),
    z.strictObject({ ...fields, n8nExecutionId: z.string() }),
  ] as const;

export const TicketEvent = z.discriminatedUnion("type", [
  event("ticket_created", z.strictObject({ requesterId: z.uuid() })),
  event(
    "classification_attempted",
    z.strictObject({
      attemptNo: z.int(),
      kind: z.enum(classificationAttemptKinds),
      outcome: z.enum(classificationOutcomes),
      provider: z.string(),
      model: z.string(),
      error: z.string().nullable(),
    }),
  ),
  event("classification_rerun_requested", z.strictObject({})),
  event("classified", Classification.extend({ team: z.enum(teams) })),
  event("priority_computed", PriorityEvaluation),
  event(
    "priority_overridden",
    z.strictObject({
      from: priority.nullable(),
      to: priority,
      computed: priority.nullable(),
      reason: z.string(),
    }),
  ),
  event("sent_to_review", z.strictObject({ reason: z.string() })),
  event(
    "dispatch_created",
    z.strictObject({
      dispatchId: z.uuid(),
      route: z.enum(routes),
      team: z.enum(teams),
    }),
  ),
  event(
    "dispatch_attempted",
    z.strictObject({
      dispatchId: z.uuid(),
      attemptNo: z.int(),
      outcome: z.enum(["sent", "failed"]),
      httpStatus: z.int().nullable(),
      error: z.string().nullable(),
    }),
  ),
  event(
    "dispatch_succeeded",
    z.union([
      ...withExecutionReference({
        ...callbackFields,
        externalReference: z.string().optional(),
      }),
      z.strictObject({
        dispatchId: z.uuid(),
        reconciled: z.literal(true),
        externalReference: z.string().optional(),
      }),
    ]),
  ),
  event(
    "dispatch_failed",
    z.union([
      // n8n did not accept the Dispatch.
      z.strictObject({ dispatchId: z.uuid(), reason: z.string() }),
      ...withExecutionReference(callbackFields),
      z.strictObject({
        dispatchId: z.uuid(),
        reconciled: z.literal(true),
        error: z.string(),
      }),
    ]),
  ),
  event("dispatch_unknown", z.strictObject({ dispatchId: z.uuid() })),
  event("dispatch_retried", z.strictObject({ dispatchId: z.uuid() })),
  event(
    "dispatch_superseded",
    z.strictObject({ dispatchId: z.uuid(), supersededBy: z.uuid() }),
  ),
  // A callback for a Dispatch that was not `sent`/`unknown`: duplicates.
  event(
    "dispatch_callback_ignored",
    z.union(
      withExecutionReference({
        dispatchId: z.uuid(),
        outcome: z.enum(["succeeded", "failed"]),
        status: z.enum(dispatchStatuses),
      }),
    ),
  ),
  event(
    "status_changed",
    z.strictObject({
      from: ticketStatus,
      to: ticketStatus,
      // The Requester's words when they close or reopen.
      reason: z.string().optional(),
    }),
  ),
  event("ticket_taken", z.strictObject({ assigneeId: z.uuid() })),
  event("ticket_released", z.strictObject({ from: z.uuid().nullable() })),
  event(
    "ticket_reassigned",
    z.strictObject({ from: z.uuid().nullable(), to: z.uuid() }),
  ),
]);
export type TicketEvent = z.infer<typeof TicketEvent>;
export type TicketEventType = TicketEvent["type"];
export type TicketEventData<T extends TicketEventType = TicketEventType> =
  Extract<TicketEvent, { type: T }>["data"];
