import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { type Actor, actorColumns } from "@/domain/actor";
import { ticketTeam } from "@/domain/permissions";
import { teamMemberships, ticketEvents, tickets } from "@/infra/db/schema";
import type { Db } from "./createTicket";

// Take, release and reassign (ADR 0008): assignment decides who is
// accountable, never who may act. The caller has already checked the actor is
// an Operator of the Ticket's Team (authorizeManualAction).

export type AssignmentResult =
  | { kind: "ok" }
  | { kind: "not_found" }
  | { kind: "already_assigned"; message: string }
  | { kind: "illegal_state"; message: string }
  | { kind: "invalid"; details: unknown };

const Reassignment = z.object({ assigneeId: z.uuid() }).strict();

// Assignment is always done by a signed-in User.
function userIdOf(actor: Actor): string {
  if (actor.kind !== "user") {
    throw new Error("Only a User can change a Ticket's assignment");
  }
  return actor.userId;
}

// Atomic: the update only matches an unowned Ticket, so of two simultaneous
// takes the second waits for the first, then matches nothing.
export async function takeTicket(
  db: Db,
  ticketId: string,
  actor: Actor,
): Promise<AssignmentResult> {
  const userId = userIdOf(actor);
  return db.transaction(async (tx): Promise<AssignmentResult> => {
    const [taken] = await tx
      .update(tickets)
      .set({ assigneeId: userId })
      .where(and(eq(tickets.id, ticketId), isNull(tickets.assigneeId)))
      .returning({ id: tickets.id });
    if (!taken) {
      const [existing] = await tx
        .select({ id: tickets.id })
        .from(tickets)
        .where(eq(tickets.id, ticketId));
      return existing
        ? {
            kind: "already_assigned",
            message: "Another Operator already took this Ticket",
          }
        : { kind: "not_found" };
    }
    await tx.insert(ticketEvents).values({
      ticketId,
      type: "ticket_taken",
      ...actorColumns(actor),
      data: { assigneeId: userId },
    });
    return { kind: "ok" };
  });
}

// Any Operator of the Team may release, so a colleague can cover for someone
// absent.
export async function releaseTicket(
  db: Db,
  ticketId: string,
  actor: Actor,
): Promise<AssignmentResult> {
  userIdOf(actor);
  return db.transaction(async (tx): Promise<AssignmentResult> => {
    const [ticket] = await tx
      .select({ assigneeId: tickets.assigneeId })
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .for("update");
    if (!ticket) return { kind: "not_found" };
    if (!ticket.assigneeId) {
      return { kind: "illegal_state", message: "The Ticket has no Assignee" };
    }
    await tx
      .update(tickets)
      .set({ assigneeId: null })
      .where(eq(tickets.id, ticketId));
    await tx.insert(ticketEvents).values({
      ticketId,
      type: "ticket_released",
      ...actorColumns(actor),
      data: { from: ticket.assigneeId },
    });
    return { kind: "ok" };
  });
}

export async function reassignTicket(
  db: Db,
  ticketId: string,
  input: unknown,
  actor: Actor,
): Promise<AssignmentResult> {
  userIdOf(actor);
  const parsed = Reassignment.safeParse(input);
  if (!parsed.success) {
    return { kind: "invalid", details: z.flattenError(parsed.error) };
  }
  const { assigneeId } = parsed.data;

  return db.transaction(async (tx): Promise<AssignmentResult> => {
    const [ticket] = await tx
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .for("update");
    if (!ticket) return { kind: "not_found" };
    if (ticket.assigneeId === assigneeId) {
      return {
        kind: "already_assigned",
        message: "The Ticket is already assigned to that User",
      };
    }

    const [member] = await tx
      .select({ userId: teamMemberships.userId })
      .from(teamMemberships)
      .where(
        and(
          eq(teamMemberships.userId, assigneeId),
          eq(teamMemberships.team, ticketTeam(ticket)),
        ),
      );
    if (!member) {
      return {
        kind: "invalid",
        details: {
          formErrors: [],
          fieldErrors: {
            assigneeId: ["Must be a member of the Ticket's Team"],
          },
        },
      };
    }

    await tx
      .update(tickets)
      .set({ assigneeId })
      .where(eq(tickets.id, ticketId));
    await tx.insert(ticketEvents).values({
      ticketId,
      type: "ticket_reassigned",
      ...actorColumns(actor),
      data: { from: ticket.assigneeId, to: assigneeId },
    });
    return { kind: "ok" };
  });
}
