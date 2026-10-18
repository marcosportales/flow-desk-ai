import type { Actor } from "@/domain/actor";
import { eq } from "drizzle-orm";
import { jobs, tickets } from "@/infra/db/schema";
import type { Db } from "./createTicket";
import { appendTicketEvent } from "./ticketWrites";

// Re-run AI classification: queues a classify job for a Ticket in Manual
// Review. The handler records the attempt as kind `rerun`. IMPLEMENTATION.md §4.7.

export type RerunResult =
  | { kind: "queued" }
  | { kind: "already_queued" }
  | { kind: "not_rerunnable"; state: string }
  | { kind: "not_found" };

export async function rerunClassification(
  db: Db,
  ticketId: string,
  actor: Actor,
): Promise<RerunResult> {
  return db.transaction(async (tx): Promise<RerunResult> => {
    const [ticket] = await tx
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .for("update");
    if (!ticket) return { kind: "not_found" };
    if (ticket.classificationState !== "needs_review") {
      return { kind: "not_rerunnable", state: ticket.classificationState };
    }

    // The unique index allows one active classify job per Ticket.
    const inserted = await tx
      .insert(jobs)
      .values({ kind: "classify", ticketId: ticket.id })
      .onConflictDoNothing()
      .returning({ id: jobs.id });
    if (inserted.length === 0) return { kind: "already_queued" };

    await appendTicketEvent(tx, ticket.id, actor, {
      type: "classification_rerun_requested",
      data: {},
    });
    return { kind: "queued" };
  });
}
