import { systemActor } from "@/domain/actor";
import type { TicketEventData } from "@/domain/ticketEvents";
import { dispatches, jobs } from "@/infra/db/schema";
import { exponentialBackoffMs } from "@/worker/runner";
import { MAX_AUTO_ATTEMPTS } from "./dispatchTicket";
import { moveDispatchStatus, type Tx } from "./ticketWrites";

type Dispatch = typeof dispatches.$inferSelect;

// A `sent` or `unknown` Dispatch learned to have failed (n8n's callback or
// Reconciliation), recorded as `dispatch_failed` with `data`. While the
// automatic budget lasts it goes straight back to `pending` with a backed-off
// dispatch job (§2.5); otherwise it stays `failed` and waits for a manual
// retry. Returns the resulting status.
export async function failDispatch(
  tx: Tx,
  dispatch: Pick<Dispatch, "id" | "ticketId" | "status" | "autoAttempts">,
  data: TicketEventData<"dispatch_failed">,
): Promise<"pending" | "failed"> {
  await moveDispatchStatus(tx, dispatch, "failed", {
    actor: systemActor,
    event: { type: "dispatch_failed", data },
  });
  if (dispatch.autoAttempts >= MAX_AUTO_ATTEMPTS) return "failed";
  await moveDispatchStatus(tx, { ...dispatch, status: "failed" }, "pending", {
    set: { callbackDeadline: null },
  });
  await tx.insert(jobs).values({
    kind: "dispatch",
    ticketId: dispatch.ticketId,
    dispatchId: dispatch.id,
    runAt: new Date(Date.now() + exponentialBackoffMs(dispatch.autoAttempts)),
  });
  return "pending";
}
