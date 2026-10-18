import type { Actor } from "@/domain/actor";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  IllegalTransitionError,
  type TicketStatus,
} from "@/domain/transitions";
import { tickets } from "@/infra/db/schema";
import type { Db } from "./createTicket";
import { notifyStatusChange } from "./notifications";
import { moveTicketStatus } from "./ticketWrites";

// The Requester's answer to a resolved Ticket: close it ("fixed") or reopen
// it ("still broken"), with a reason shown in the timeline. It reuses the
// existing Ticket Status transitions; who may call it is decided by the caller.

const requesterResponses = ["close", "reopen"] as const;
const targetStatus: Record<(typeof requesterResponses)[number], TicketStatus> =
  { close: "closed", reopen: "open" };

const Response = z
  .object({
    response: z.enum(requesterResponses),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();

export type RespondToResolutionResult =
  | { kind: "ok" }
  | { kind: "not_found" }
  | { kind: "invalid"; details: unknown }
  | { kind: "illegal_transition"; message: string };

export async function respondToResolution(
  db: Db,
  ticketId: string,
  input: unknown,
  actor: Actor,
): Promise<RespondToResolutionResult> {
  const parsed = Response.safeParse(input);
  if (!parsed.success) {
    return { kind: "invalid", details: z.flattenError(parsed.error) };
  }
  const to = targetStatus[parsed.data.response];

  return db.transaction(async (tx): Promise<RespondToResolutionResult> => {
    const [ticket] = await tx
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .for("update");
    if (!ticket) return { kind: "not_found" };

    let event;
    try {
      event = await moveTicketStatus(tx, ticket, to, actor, parsed.data.reason);
    } catch (error) {
      if (!(error instanceof IllegalTransitionError)) throw error;
      return { kind: "illegal_transition", message: error.message };
    }
    await notifyStatusChange(tx, event, ticket.requesterId, to, actor);
    return { kind: "ok" };
  });
}
