import { type Actor, actorColumns } from "@/domain/actor";
import { eq } from "drizzle-orm";
import { transitionDispatchStatus } from "@/domain/transitions";
import {
  dispatches,
  jobs,
  type NewTicketEvent,
  ticketEvents,
} from "@/infra/db/schema";
import type { Db } from "./createTicket";

// Manual retry of a failed Dispatch: docs/plan/IMPLEMENTATION.md §4.7. The
// Dispatch keeps its id, so n8n and the notifier see the same idempotency key.

export type RetryResult =
  | { kind: "queued" }
  | { kind: "not_retryable"; status: string }
  | { kind: "not_found" };

export async function retryDispatch(
  db: Db,
  dispatchId: string,
  actor: Actor,
): Promise<RetryResult> {
  return db.transaction(async (tx) => {
    const [dispatch] = await tx
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, dispatchId))
      .for("update");
    if (!dispatch) return { kind: "not_found" };
    // A superseded Dispatch is history; its replacement is the one to retry.
    if (dispatch.status !== "failed" || dispatch.supersededBy) {
      return { kind: "not_retryable", status: dispatch.status };
    }

    transitionDispatchStatus(dispatch.status, "pending");
    await tx
      .update(dispatches)
      .set({ status: "pending", callbackDeadline: null })
      .where(eq(dispatches.id, dispatch.id));
    await tx.insert(jobs).values({
      kind: "dispatch",
      ticketId: dispatch.ticketId,
      dispatchId: dispatch.id,
    });
    await tx.insert(ticketEvents).values({
      ticketId: dispatch.ticketId,
      type: "dispatch_retried",
      ...actorColumns(actor),
      data: { dispatchId: dispatch.id },
    } satisfies NewTicketEvent);
    return { kind: "queued" };
  });
}
