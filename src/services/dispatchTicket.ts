import { eq, max, sql } from "drizzle-orm";
import { systemActor } from "@/domain/actor";
import { formatTicketNumber } from "@/domain/ticketNumber";
import { workflowEngineLabels } from "@/domain/workflowEngine";
import { dispatchAttempts, dispatches, tickets } from "@/infra/db/schema";
import type { DispatchConfig } from "@/infra/workflowEngine/config";
import { sendDispatchEvent } from "@/infra/workflowEngine/client";
import type { Db } from "./createTicket";
import { appendTicketEvent, moveDispatchStatus } from "./ticketWrites";

// Dispatch handler: docs/plan/IMPLEMENTATION.md §4.4, ADR 0005, ADR 0006,
// ADR 0011. The app has already decided Category, Priority, Team and Route;
// the Workflow Engine only executes and reports back on its callback webhook.

export const MAX_AUTO_ATTEMPTS = 3;

type DispatchJob = { dispatchId: string | null };

export async function dispatchTicket(
  db: Db,
  config: DispatchConfig,
  job: DispatchJob,
): Promise<void> {
  if (!job.dispatchId) throw new Error("dispatch job without a dispatch_id");
  const dispatchId = job.dispatchId;

  // The row lock is held across the POST: the engine answers 202 and may call
  // back before this commits, and the callback's own lock then waits for `sent`
  // instead of finding the Dispatch still `pending`. It also stops a second
  // worker (after a reclaimed lease) from sending the same Dispatch twice.
  const leaveJobToRetry = await db.transaction(async (tx) => {
    const [dispatch] = await tx
      .select()
      .from(dispatches)
      .where(eq(dispatches.id, dispatchId))
      .for("update");
    if (!dispatch) throw new Error(`Dispatch ${dispatchId} not found`);
    if (dispatch.status !== "pending") return false;
    const [ticket] = await tx
      .select()
      .from(tickets)
      .where(eq(tickets.id, dispatch.ticketId));
    if (!ticket) throw new Error(`Ticket ${dispatch.ticketId} not found`);

    // Only a manual retry (§4.7) reaches the handler with the automatic budget
    // already spent; automatic retries and Reconciliation follow-ups never do.
    const manual = dispatch.autoAttempts >= MAX_AUTO_ATTEMPTS;
    const body = JSON.stringify({
      dispatch_id: dispatch.id,
      ticket: {
        id: ticket.id,
        number: formatTicketNumber(ticket.number),
        title: ticket.title,
        summary: ticket.summary,
      },
      category: dispatch.category,
      priority: dispatch.priority,
      team: dispatch.team,
      route: dispatch.route,
      callback_url: config.callbackUrl,
    });
    // Every attempt, retries included, goes to the engine configured now.
    const workflowEngine = config.engine.kind;
    const engineLabel = workflowEngineLabels[workflowEngine];
    const startedAt = new Date();
    const result = await sendDispatchEvent(config.engine, body);
    const outcome = result.ok ? "sent" : "failed";
    const failure = {
      httpStatus: result.httpStatus,
      error: result.ok ? null : result.error,
    };

    const [{ last }] = (await tx
      .select({ last: max(dispatchAttempts.attemptNo) })
      .from(dispatchAttempts)
      .where(eq(dispatchAttempts.dispatchId, dispatch.id))) as [
      { last: number | null },
    ];
    const attemptNo = (last ?? 0) + 1;
    await tx.insert(dispatchAttempts).values({
      dispatchId: dispatch.id,
      attemptNo,
      trigger: manual ? "manual" : "auto",
      workflowEngine,
      outcome,
      ...failure,
      startedAt,
      finishedAt: new Date(),
    });
    await appendTicketEvent(tx, dispatch.ticketId, systemActor, {
      type: "dispatch_attempted",
      data: {
        dispatchId: dispatch.id,
        attemptNo,
        workflowEngine,
        outcome,
        ...failure,
      },
    });

    // A manual attempt is a single try: it does not spend the automatic budget
    // and, if it fails, goes straight back to `failed`.
    const autoAttempts = manual
      ? dispatch.autoAttempts
      : dispatch.autoAttempts + 1;
    const exhausted =
      !result.ok && (manual || autoAttempts >= MAX_AUTO_ATTEMPTS);
    const status = result.ok ? "sent" : exhausted ? "failed" : "pending";
    const set = {
      autoAttempts,
      callbackDeadline: result.ok
        ? sql`now() + ${`${config.callbackTimeoutSeconds} seconds`}::interval`
        : null,
    };
    if (!exhausted) {
      await moveDispatchStatus(tx, dispatch, status, { set });
      return !result.ok;
    }
    await moveDispatchStatus(tx, dispatch, status, {
      set,
      actor: systemActor,
      event: {
        type: "dispatch_failed",
        data: {
          dispatchId: dispatch.id,
          reason: manual
            ? `${engineLabel} did not accept the manual retry: ${result.error}`
            : `${engineLabel} did not accept the Dispatch after ${autoAttempts} attempts: ${result.error}`,
        },
      },
    });
    return false;
  });

  // Committed above; the throw only makes the worker re-run the job with
  // backoff while the automatic budget lasts.
  if (leaveJobToRetry)
    throw new Error(
      `Dispatch ${dispatchId} not accepted by the Workflow Engine`,
    );
}
