import type { Actor } from "@/domain/actor";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { IllegalTransitionError, ticketStatuses } from "@/domain/transitions";
import { tickets } from "@/infra/db/schema";
import type { Db } from "./createTicket";
import { notifyStatusChange } from "./notifications";
import { moveTicketStatus } from "./ticketWrites";

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
  actor: Actor,
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

    let event;
    try {
      event = await moveTicketStatus(tx, ticket, parsed.data.status, actor);
    } catch (error) {
      if (!(error instanceof IllegalTransitionError)) throw error;
      return { kind: "illegal_transition", message: error.message };
    }
    await notifyStatusChange(
      tx,
      event,
      ticket.requesterId,
      parsed.data.status,
      actor,
    );
    return { kind: "ok" };
  });
}
