import type { Actor } from "@/domain/actor";
import { eq } from "drizzle-orm";
import { dispatches, jobs } from "@/infra/db/schema";
import type { Db } from "./createTicket";
import { moveDispatchStatus } from "./ticketWrites";

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

    await moveDispatchStatus(tx, dispatch, "pending", {
      set: { callbackDeadline: null },
      actor,
      event: { type: "dispatch_retried", data: { dispatchId: dispatch.id } },
    });
    await tx.insert(jobs).values({
      kind: "dispatch",
      ticketId: dispatch.ticketId,
      dispatchId: dispatch.id,
    });
    return { kind: "queued" };
  });
}
