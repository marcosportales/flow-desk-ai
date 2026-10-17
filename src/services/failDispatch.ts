import { eq } from "drizzle-orm";
import { transitionDispatchStatus } from "@/domain/transitions";
import { dispatches, jobs } from "@/infra/db/schema";
import { exponentialBackoffMs } from "@/worker/runner";
import type { Db } from "./createTicket";
import { MAX_AUTO_ATTEMPTS } from "./dispatchTicket";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Dispatch = typeof dispatches.$inferSelect;

// A `sent` or `unknown` Dispatch learned to have failed (n8n's callback or
// Reconciliation). While the automatic budget lasts it goes straight back to
// `pending` with a backed-off dispatch job (§2.5); otherwise it stays `failed`
// and waits for a manual retry. Returns the resulting status.
export async function failDispatch(
  tx: Tx,
  dispatch: Pick<Dispatch, "id" | "ticketId" | "status" | "autoAttempts">,
): Promise<"pending" | "failed"> {
  const failed = transitionDispatchStatus(dispatch.status, "failed");
  if (dispatch.autoAttempts >= MAX_AUTO_ATTEMPTS) {
    await tx
      .update(dispatches)
      .set({ status: failed })
      .where(eq(dispatches.id, dispatch.id));
    return "failed";
  }
  const pending = transitionDispatchStatus(failed, "pending");
  await tx
    .update(dispatches)
    .set({ status: pending, callbackDeadline: null })
    .where(eq(dispatches.id, dispatch.id));
  await tx.insert(jobs).values({
    kind: "dispatch",
    ticketId: dispatch.ticketId,
    dispatchId: dispatch.id,
    runAt: new Date(Date.now() + exponentialBackoffMs(dispatch.autoAttempts)),
  });
  return "pending";
}
