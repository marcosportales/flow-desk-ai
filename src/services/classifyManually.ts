import { type Actor, actorColumns } from "@/domain/actor";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { Classification } from "@/domain/classification";
import { evaluatePriority } from "@/domain/priority";
import { isDispatchable, teamFor } from "@/domain/routing";
import {
  IllegalTransitionError,
  transitionClassificationState,
} from "@/domain/transitions";
import { ticketEvents, tickets } from "@/infra/db/schema";
import type { Db } from "./createTicket";
import { type ManualFailure, rerouteDispatch } from "./dispatchRouting";
import { notifyQueueEntry } from "./notifications";

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
    if (ticket.classificationState !== nextState) {
      try {
        transitionClassificationState(ticket.classificationState, nextState);
      } catch (error) {
        if (!(error instanceof IllegalTransitionError)) throw error;
        return { kind: "illegal_state", message: error.message };
      }
    }

    const evaluation = evaluatePriority(facts);
    const team = teamFor(facts.category);
    await tx
      .update(tickets)
      .set({
        classificationState: nextState,
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
      })
      .where(eq(tickets.id, ticket.id));
    const [classified] = await tx
      .insert(ticketEvents)
      .values([
        {
          ticketId: ticket.id,
          type: "classified",
          ...actorColumns(actor),
          data: { ...facts, team },
        },
        {
          ticketId: ticket.id,
          type: "priority_computed",
          actor: "system",
          data: evaluation,
        },
      ])
      .returning({ id: ticketEvents.id, ticketId: ticketEvents.ticketId });
    await notifyQueueEntry(tx, classified!, ticket, team, actor);

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
