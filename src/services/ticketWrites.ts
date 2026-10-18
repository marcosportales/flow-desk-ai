import { and, eq } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { type Actor, actorColumns } from "@/domain/actor";
import type { TicketEvent } from "@/domain/ticketEvents";
import {
  type ClassificationState,
  type DispatchStatus,
  type TicketStatus,
  transitionClassificationState,
  transitionDispatchStatus,
  transitionTicketStatus,
} from "@/domain/transitions";
import {
  dispatches,
  type NewTicketEvent,
  ticketEvents,
  tickets,
} from "@/infra/db/schema";
import type { Db, Ticket } from "./createTicket";

type Dispatch = typeof dispatches.$inferSelect;

// The one write path for the status axes and Ticket Events (ADR 0010): every
// status change is checked against src/domain/transitions.ts and written with
// its Ticket Event in the caller's transaction. ESLint rejects writing a
// status or inserting a Ticket Event anywhere else.

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type EventRef = { id: number; ticketId: string };

export async function appendTicketEvent(
  tx: Tx,
  ticketId: string,
  actor: Actor,
  event: TicketEvent,
): Promise<EventRef> {
  const [row] = await tx
    .insert(ticketEvents)
    .values({
      ticketId,
      ...actorColumns(actor),
      ...event,
    } satisfies NewTicketEvent)
    .returning({ id: ticketEvents.id, ticketId: ticketEvents.ticketId });
  return row!;
}

// The update matches on the status the caller read, so a caller that did not
// lock the row cannot write a move from a status it is no longer in.
function assertMoved(rows: unknown[], what: string, id: string, from: string) {
  if (rows.length === 0) {
    throw new Error(`${what} ${id} is no longer ${from}`);
  }
}

// What a move writes besides the status: other columns of the same row, set in
// the same statement, and the Ticket Event that records it, if any.
type Change<Set> = { set?: Set } & (
  | { event?: undefined; actor?: undefined }
  | { event: TicketEvent; actor: Actor }
);

// A move answers with its Ticket Event exactly when it was given one.
type Moved<C> = C extends { event: TicketEvent } ? EventRef : undefined;

async function appendChange<Set, C extends Change<Set>>(
  tx: Tx,
  ticketId: string,
  change: C,
): Promise<Moved<C>> {
  return (
    change.event
      ? await appendTicketEvent(tx, ticketId, change.actor!, change.event)
      : undefined
  ) as Moved<C>;
}

type TicketColumns = Omit<
  PgUpdateSetSource<typeof tickets>,
  "id" | "status" | "classificationState"
>;

// Staying in the same state is not a transition: only `set` (if any) and the
// event are written. Facts and state go in one statement, since
// tickets_classified_has_facts checks them together.
export async function moveClassificationState<
  C extends Change<TicketColumns> = Change<TicketColumns>,
>(
  tx: Tx,
  ticket: Pick<Ticket, "id" | "classificationState">,
  to: ClassificationState,
  change: C = {} as C,
): Promise<Moved<C>> {
  const from = ticket.classificationState;
  if (from !== to || change.set) {
    if (from !== to) transitionClassificationState(from, to);
    const rows = await tx
      .update(tickets)
      .set({ ...change.set, classificationState: to })
      .where(
        and(eq(tickets.id, ticket.id), eq(tickets.classificationState, from)),
      )
      .returning({ id: tickets.id });
    assertMoved(rows, "Ticket", ticket.id, from);
  }
  return appendChange(tx, ticket.id, change);
}

type DispatchColumns = Omit<
  PgUpdateSetSource<typeof dispatches>,
  "id" | "ticketId" | "status"
>;

// Staying in the same state is not a transition: only `set` (if any) and the
// event are written. The event goes on the Dispatch's Ticket.
export async function moveDispatchStatus<
  C extends Change<DispatchColumns> = Change<DispatchColumns>,
>(
  tx: Tx,
  dispatch: Pick<Dispatch, "id" | "ticketId" | "status">,
  to: DispatchStatus,
  change: C = {} as C,
): Promise<Moved<C>> {
  const from = dispatch.status;
  if (from !== to || change.set) {
    if (from !== to) transitionDispatchStatus(from, to);
    const rows = await tx
      .update(dispatches)
      .set({ ...change.set, status: to })
      .where(and(eq(dispatches.id, dispatch.id), eq(dispatches.status, from)))
      .returning({ id: dispatches.id });
    assertMoved(rows, "Dispatch", dispatch.id, from);
  }
  return appendChange(tx, dispatch.ticketId, change);
}

export async function moveTicketStatus(
  tx: Tx,
  ticket: Pick<Ticket, "id" | "status">,
  to: TicketStatus,
  actor: Actor,
  // The Requester's words when they close or reopen.
  reason?: string,
): Promise<EventRef> {
  const from = ticket.status;
  transitionTicketStatus(from, to);
  const rows = await tx
    .update(tickets)
    .set({ status: to })
    .where(and(eq(tickets.id, ticket.id), eq(tickets.status, from)))
    .returning({ id: tickets.id });
  assertMoved(rows, "Ticket", ticket.id, from);
  return appendTicketEvent(tx, ticket.id, actor, {
    type: "status_changed",
    data: reason === undefined ? { from, to } : { from, to, reason },
  });
}
