import { type Actor, systemActor } from "@/domain/actor";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { Classification } from "@/domain/classification";
import { evaluatePriority } from "@/domain/priority";
import { isDispatchable, teamFor } from "@/domain/routing";
import { IllegalTransitionError } from "@/domain/transitions";
import { tickets } from "@/infra/db/schema";
import type { Db } from "./createTicket";
import { type ManualFailure, rerouteDispatch } from "./dispatchRouting";
import { notifyQueueEntry } from "./notifications";
import { appendTicketEvent, moveClassificationState } from "./ticketWrites";

// Manual classification: a human enters the facts, the rules recompute the
// Priority (ADR 0001), and a changed Team or Route gets a new Dispatch.
// docs/plan/IMPLEMENTATION.md §4.7.

export type ClassifyManuallyResult = { kind: "ok" } | ManualFailure;

export async function classifyManually(
  db: Db,
  ticketId: string,
  input: unknown,
  actor: Actor,
): Promise<ClassifyManuallyResult> {
  const parsed = Classification.safeParse(input);
  if (!parsed.success) {
    return { kind: "invalid", details: z.flattenError(parsed.error) };
  }
  const facts = parsed.data;

  return db.transaction(async (tx): Promise<ClassifyManuallyResult> => {
    const [ticket] = await tx
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticketId))
      .for("update");
    if (!ticket) return { kind: "not_found" };

    // A non-dispatchable Category stays in review (like the AI path).
    const dispatchable = isDispatchable(facts.category);
    const nextState = dispatchable ? "classified" : "needs_review";
    if (ticket.classificationState === "pending") {
      return {
        kind: "illegal_state",
        message:
          "The Ticket is still waiting for the AI; classify it once it is in review",
      };
    }
    const evaluation = evaluatePriority(facts);
    const team = teamFor(facts.category);
    let classified;
    try {
      classified = await moveClassificationState(tx, ticket, nextState, {
        set: {
          category: facts.category,
          summary: facts.summary,
          blocksWork: facts.blocks_work,
          impactScope: facts.impact_scope,
          classificationSource: "human",
          priority: evaluation.priority,
          computedPriority: evaluation.priority,
          priorityRule: evaluation.rule,
          // The facts changed, so an earlier Priority Override no longer applies.
          priorityOverrideReason: null,
          team,
        },
        actor,
        event: { type: "classified", data: { ...facts, team } },
      });
    } catch (error) {
      if (!(error instanceof IllegalTransitionError)) throw error;
      return { kind: "illegal_state", message: error.message };
    }
    await appendTicketEvent(tx, ticket.id, systemActor, {
      type: "priority_computed",
      data: evaluation,
    });
    await notifyQueueEntry(tx, classified, ticket, team, actor);

    if (dispatchable) {
      await rerouteDispatch(
        tx,
        ticket.id,
        { category: facts.category, priority: evaluation.priority, team },
        actor,
      );
    }
    return { kind: "ok" };
  });
}
