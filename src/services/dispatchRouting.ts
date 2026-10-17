import { desc, eq, max } from "drizzle-orm";
import type { Category } from "@/domain/classification";
import type { Priority } from "@/domain/priority";
import { routeFor, type Team } from "@/domain/routing";
import { transitionDispatchStatus } from "@/domain/transitions";
import { dispatches, jobs, ticketEvents } from "@/infra/db/schema";
import type { Db } from "./createTicket";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// What a manual action answers with; each caller adds its own failure kinds.
export type ManualFailure =
  | { kind: "not_found" }
  | { kind: "invalid"; details: unknown }
  | { kind: "illegal_state"; message: string };

type Routing = { category: Category; priority: Priority; team: Team };

// Creates the next Dispatch for a Ticket and queues its job.
export async function createDispatch(
  tx: Tx,
  ticketId: string,
  routing: Routing,
) {
  const [{ last }] = (await tx
    .select({ last: max(dispatches.sequence) })
    .from(dispatches)
    .where(eq(dispatches.ticketId, ticketId))) as [{ last: number | null }];
  const route = routeFor(routing.priority);
  const [dispatch] = await tx
    .insert(dispatches)
    .values({ ticketId, sequence: (last ?? 0) + 1, ...routing, route })
    .returning();
  await tx.insert(ticketEvents).values({
    ticketId,
    type: "dispatch_created",
    actor: "system",
    data: { dispatchId: dispatch!.id, route, team: routing.team },
  });
  await tx.insert(jobs).values({
    kind: "dispatch",
    ticketId,
    dispatchId: dispatch!.id,
  });
  return dispatch!;
}

// After a manual change: if the Team or Route differ from the Ticket's latest
// Dispatch, supersede it and create a new one (IMPLEMENTATION.md §4.7). The old
// Dispatch and its history stay; an active one is closed as `failed` so n8n
// callbacks for it are ignored and it cannot be retried.
export async function rerouteDispatch(
  tx: Tx,
  ticketId: string,
  routing: Routing,
): Promise<void> {
  const [latest] = await tx
    .select()
    .from(dispatches)
    .where(eq(dispatches.ticketId, ticketId))
    .orderBy(desc(dispatches.sequence))
    .limit(1)
    .for("update");
  if (
    latest &&
    latest.team === routing.team &&
    latest.route === routeFor(routing.priority)
  ) {
    return;
  }

  if (latest && ["pending", "sent", "unknown"].includes(latest.status)) {
    transitionDispatchStatus(latest.status, "failed");
    await tx
      .update(dispatches)
      .set({ status: "failed", callbackDeadline: null })
      .where(eq(dispatches.id, latest.id));
  }
  const created = await createDispatch(tx, ticketId, routing);
  if (latest) {
    await tx
      .update(dispatches)
      .set({ supersededBy: created.id })
      .where(eq(dispatches.id, latest.id));
    await tx.insert(ticketEvents).values({
      ticketId,
      type: "dispatch_superseded",
      actor: "human",
      data: { dispatchId: latest.id, supersededBy: created.id },
    });
  }
}
