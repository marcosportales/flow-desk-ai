import { eq, max } from "drizzle-orm";
import { transitionDispatchStatus } from "@/domain/transitions";
import { dispatchAttempts, dispatches, ticketEvents } from "@/infra/db/schema";
import { deliveryExists, type NotifierConfig } from "@/infra/notifier/client";
import type { Db } from "./createTicket";
import { failDispatch } from "./failDispatch";

// Reconcile handler: docs/plan/IMPLEMENTATION.md §4.6, ADR 0006. Asks the
// target service whether it holds the Dispatch's id before anything may be
// retried, so a lost response never turns into a second delivery.

type ReconcileJob = { dispatchId: string | null };

export async function reconcileDispatch(
  db: Db,
  config: NotifierConfig,
  job: ReconcileJob,
): Promise<void> {
  if (!job.dispatchId) throw new Error("reconcile job without a dispatch_id");
  const dispatchId = job.dispatchId;

  await db.transaction(async (tx) => {
    // The lock keeps a late callback from settling the Dispatch mid-lookup.
    const [dispatch] = await tx
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, dispatchId))
      .for("update");
    if (!dispatch) throw new Error(`Dispatch ${dispatchId} not found`);
    // A late callback got there first.
    if (dispatch.status !== "unknown") return;

    // Throws when the notifier is unreachable: the Dispatch stays `unknown`
    // and the runner retries the job with backoff.
    const startedAt = new Date();
    const delivered = await deliveryExists(config, dispatch.id);

    const [{ last }] = (await tx
      .select({ last: max(dispatchAttempts.attemptNo) })
      .from(dispatchAttempts)
      .where(eq(dispatchAttempts.dispatchId, dispatch.id))) as [
      { last: number | null },
    ];
    const outcome = delivered ? "succeeded" : "failed";
    await tx.insert(dispatchAttempts).values({
      dispatchId: dispatch.id,
      attemptNo: (last ?? 0) + 1,
      trigger: "reconcile",
      outcome,
      error: delivered ? null : "notifier holds no delivery for this Dispatch",
      startedAt,
      finishedAt: new Date(),
    });

    if (delivered) {
      transitionDispatchStatus(dispatch.status, "succeeded");
      await tx
        .update(dispatches)
        .set({ status: "succeeded" })
        .where(eq(dispatches.id, dispatch.id));
    } else {
      await failDispatch(tx, dispatch);
    }
    await tx.insert(ticketEvents).values({
      ticketId: dispatch.ticketId,
      type: delivered ? "dispatch_succeeded" : "dispatch_failed",
      actor: "system",
      data: {
        dispatchId: dispatch.id,
        reconciled: true,
        ...(delivered
          ? {}
          : { error: "notifier holds no delivery for this Dispatch" }),
      },
    });
  });
}
