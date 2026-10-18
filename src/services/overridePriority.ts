import { type Actor, actorColumns } from "@/domain/actor";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { priorities } from "@/domain/priority";
import { ticketEvents, tickets } from "@/infra/db/schema";
import type { Db } from "./createTicket";
import { type ManualFailure, rerouteDispatch } from "./dispatchRouting";

// Priority Override: a human replaces the computed Priority and must say why.
// docs/plan/IMPLEMENTATION.md §4.7.

const Override = z
  .object({
    priority: z.enum(priorities),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export type OverridePriorityResult = { kind: "ok" } | ManualFailure;

export async function overridePriority(
  db: Db,
  ticketId: string,
  input: unknown,
  actor: Actor,
): Promise<OverridePriorityResult> {
  const parsed = Override.safeParse(input);
  if (!parsed.success) {
    return { kind: "invalid", details: z.flattenError(parsed.error) };
  }
  const { priority, reason } = parsed.data;

  return db.transaction(async (tx): Promise<OverridePriorityResult> => {
    const [ticket] = await tx
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .for("update");
    if (!ticket) return { kind: "not_found" };
    if (
      ticket.classificationState !== "classified" ||
      !ticket.category ||
      !ticket.team ||
      !ticket.computedPriority
    ) {
      return {
        kind: "illegal_state",
        message: "Only a classified Ticket can have its Priority overridden",
      };
    }

    // Setting the computed Priority back removes the override.
    const restored = priority === ticket.computedPriority;
    await tx
      .update(tickets)
      .set({
        priority,
        priorityOverrideReason: restored ? null : reason,
      })
      .where(eq(tickets.id, ticket.id));
    await tx.insert(ticketEvents).values({
      ticketId: ticket.id,
      type: "priority_overridden",
      ...actorColumns(actor),
      data: {
        from: ticket.priority,
        to: priority,
        computed: ticket.computedPriority,
        reason,
      },
    });

    await rerouteDispatch(
      tx,
      ticket.id,
      { category: ticket.category, priority, team: ticket.team },
      actor,
    );
    return { kind: "ok" };
  });
}
