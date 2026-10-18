import { and, asc, eq, inArray } from "drizzle-orm";
import {
  classificationAttempts,
  dispatchAttempts,
  dispatches,
  users,
  ticketEvents,
  tickets,
} from "@/infra/db/schema";
import type { PriorityEvaluation } from "@/domain/priority";
import type { Db } from "./createTicket";
import type { RequesterScope } from "./listTickets";

type Ticket = typeof tickets.$inferSelect;
type Dispatch = typeof dispatches.$inferSelect;

export type DispatchWithAttempts = Dispatch & {
  attempts: (typeof dispatchAttempts.$inferSelect)[];
};

export type TicketDetail = {
  // Idempotency internals stay server-side.
  ticket: Omit<Ticket, "requestHash" | "idempotencyKey">;
  requester: Pick<
    typeof users.$inferSelect,
    "id" | "name" | "email" | "department"
  >;
  classificationAttempts: (typeof classificationAttempts.$inferSelect)[];
  dispatches: DispatchWithAttempts[];
  events: (typeof ticketEvents.$inferSelect)[];
  // The rule table as recorded when the Priority was computed.
  priorityEvaluation: PriorityEvaluation | null;
  // The AI's Reason, from the latest `classified` event.
  reason: string | null;
  // False while the page should keep refreshing: classification or a Dispatch
  // is still in flight.
  settled: boolean;
};

export type TicketDetailResult =
  { kind: "ok"; detail: TicketDetail } | { kind: "not_found" };

const inFlightDispatch = ["pending", "sent", "unknown"];

export async function getTicketDetail(
  db: Db,
  id: string,
  scope?: RequesterScope,
): Promise<TicketDetailResult> {
  const [row] = await db
    .select({
      ticket: tickets,
      requester: {
        id: users.id,
        name: users.name,
        email: users.email,
        department: users.department,
      },
    })
    .from(tickets)
    .innerJoin(users, eq(users.id, tickets.requesterId))
    .where(
      and(
        eq(tickets.id, id),
        scope && eq(tickets.requesterId, scope.requesterId),
      ),
    );
  // Another User's Ticket is indistinguishable from a missing one.
  if (!row) return { kind: "not_found" };

  const [attempts, dispatchRows, events] = await Promise.all([
    db
      .select()
      .from(classificationAttempts)
      .where(eq(classificationAttempts.ticketId, id))
      .orderBy(asc(classificationAttempts.attemptNo)),
    db
      .select()
      .from(dispatches)
      .where(eq(dispatches.ticketId, id))
      .orderBy(asc(dispatches.sequence)),
    db
      .select()
      .from(ticketEvents)
      .where(eq(ticketEvents.ticketId, id))
      .orderBy(asc(ticketEvents.id)),
  ]);

  const dispatchIds = dispatchRows.map((d) => d.id);
  const attemptRows = dispatchIds.length
    ? await db
        .select()
        .from(dispatchAttempts)
        .where(inArray(dispatchAttempts.dispatchId, dispatchIds))
        .orderBy(asc(dispatchAttempts.attemptNo))
    : [];

  const internals: Partial<Ticket> = { ...row.ticket };
  delete internals.requestHash;
  delete internals.idempotencyKey;
  const ticket = internals as TicketDetail["ticket"];

  const lastEvent = (type: string) =>
    events.findLast((e) => e.type === type)?.data as
      Record<string, unknown> | undefined;
  const reason = lastEvent("classified")?.reason;

  const settled =
    ticket.classificationState !== "pending" &&
    !dispatchRows.some((d) => inFlightDispatch.includes(d.status));

  return {
    kind: "ok",
    detail: {
      ticket,
      requester: row.requester,
      classificationAttempts: attempts,
      dispatches: dispatchRows.map((d) => ({
        ...d,
        attempts: attemptRows.filter((a) => a.dispatchId === d.id),
      })),
      events,
      priorityEvaluation:
        (lastEvent("priority_computed") as PriorityEvaluation | undefined) ??
        null,
      reason: typeof reason === "string" ? reason : null,
      settled,
    },
  };
}
