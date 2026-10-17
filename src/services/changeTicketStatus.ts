import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  IllegalTransitionError,
  ticketStatuses,
  transitionTicketStatus,
} from "@/domain/transitions";
import { ticketEvents, tickets } from "@/infra/db/schema";
import type { Db } from "./createTicket";

// Ticket Status change by a human, including resolving an Inquiry without a
// Dispatch. Event only: it never touches Dispatches. IMPLEMENTATION.md §4.7.

const StatusChange = z.object({ status: z.enum(ticketStatuses) }).strict();

export type ChangeStatusResult =
  | { kind: "ok" }
  | { kind: "not_found" }
  | { kind: "invalid"; details: unknown }
  | { kind: "illegal_transition"; message: string };

export async function changeTicketStatus(
  db: Db,
  ticketId: string,
  input: unknown,
): Promise<ChangeStatusResult> {
  const parsed = StatusChange.safeParse(input);
  if (!parsed.success) {
    return { kind: "invalid", details: z.flattenError(parsed.error) };
  }

  return db.transaction(async (tx): Promise<ChangeStatusResult> => {
    const [ticket] = await tx
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .for("update");
    if (!ticket) return { kind: "not_found" };

    try {
      transitionTicketStatus(ticket.status, parsed.data.status);
    } catch (error) {
      if (!(error instanceof IllegalTransitionError)) throw error;
      return { kind: "illegal_transition", message: error.message };
    }
    await tx
      .update(tickets)
      .set({ status: parsed.data.status })
      .where(eq(tickets.id, ticket.id));
    await tx.insert(ticketEvents).values({
      ticketId: ticket.id,
      type: "status_changed",
      actor: "human",
      data: { from: ticket.status, to: parsed.data.status },
    });
    return { kind: "ok" };
  });
}
