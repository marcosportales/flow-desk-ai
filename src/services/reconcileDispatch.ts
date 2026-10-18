import { eq, max } from "drizzle-orm";
import { transitionDispatchStatus } from "@/domain/transitions";
import {
  dispatchAttempts,
  dispatches,
  ticketEvents,
  tickets,
} from "@/infra/db/schema";
import { type ErpConfig, findIncident } from "@/infra/erp/client";
import { deliveryExists, type NotifierConfig } from "@/infra/notifier/client";
import type { Db } from "./createTicket";
import { failDispatch } from "./failDispatch";

// Reconcile handler: docs/plan/IMPLEMENTATION.md §4.6, ADR 0006. Asks the
// target service whether it holds the Dispatch's id before anything may be
// retried, so a lost response never turns into a second delivery. An `erp`
// Dispatch went to the simulated ERP (ADR 0009); every other one to the
// notifier.

export type ReconcileConfig = NotifierConfig & ErpConfig;

type ReconcileJob = { dispatchId: string | null };

type Lookup = { found: boolean; externalReference?: string; missing: string };

// Throws when the target is unreachable.
async function askTarget(
  config: ReconcileConfig,
  dispatch: typeof dispatches.$inferSelect,
): Promise<Lookup> {
  if (dispatch.category === "erp") {
    const incident = await findIncident(config, dispatch.id);
    return {
      found: incident !== null,
      externalReference: incident?.reference,
      missing: "ERP holds no incident for this Dispatch",
    };
  }
  return {
    found: await deliveryExists(config, dispatch.id),
    missing: "notifier holds no delivery for this Dispatch",
  };
}

export async function reconcileDispatch(
  db: Db,
  config: ReconcileConfig,
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

    // Throws when the target is unreachable: the Dispatch stays `unknown`
    // and the runner retries the job with backoff.
    const startedAt = new Date();
    const lookup = await askTarget(config, dispatch);
    const delivered = lookup.found;

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
      error: delivered ? null : lookup.missing,
      startedAt,
      finishedAt: new Date(),
    });

    if (delivered) {
      transitionDispatchStatus(dispatch.status, "succeeded");
      await tx
        .update(dispatches)
        .set({ status: "succeeded" })
        .where(eq(dispatches.id, dispatch.id));
      if (lookup.externalReference) {
        await tx
          .update(tickets)
          .set({ externalReference: lookup.externalReference })
          .where(eq(tickets.id, dispatch.ticketId));
      }
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
          ? lookup.externalReference
            ? { externalReference: lookup.externalReference }
            : {}
          : { error: lookup.missing }),
      },
    });
  });
}
