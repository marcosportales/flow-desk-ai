import { eq, max } from "drizzle-orm";
import { z } from "zod";
import { Classification } from "@/domain/classification";
import { systemActor } from "@/domain/actor";
import { ticketTeam } from "@/domain/permissions";
import { evaluatePriority } from "@/domain/priority";
import { isDispatchable, teamFor } from "@/domain/routing";
import {
  type Classifier,
  type ClassifierInput,
  ClassifierProviderError,
} from "@/infra/classifier/types";
import { classificationAttempts, tickets } from "@/infra/db/schema";
import type { Db } from "./createTicket";
import { createDispatch } from "./dispatchRouting";
import { notifyQueueEntry } from "./notifications";
import {
  appendTicketEvent,
  moveClassificationState,
  type Tx,
} from "./ticketWrites";

// Classify handler: docs/plan/IMPLEMENTATION.md §2.5, §4.3. Invalid or
// unavailable AI never triggers actions (Scenario D): the Ticket goes to
// manual review and no Dispatch is created.

type ClassifyJob = { ticketId: string; attempts: number; maxAttempts: number };

type Attempt = {
  kind: "initial" | "repair" | "rerun";
  outcome: "valid" | "invalid_output" | "provider_error";
  rawOutput?: string;
  parsed?: Classification;
  error?: string;
  latencyMs: number;
};

type Parsed =
  { ok: true; facts: Classification } | { ok: false; error: string };

// Models often wrap JSON in a code fence when they have no JSON mode.
function parseClassification(rawOutput: string): Parsed {
  const fenced = rawOutput.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  let json: unknown;
  try {
    json = JSON.parse(fenced ? fenced[1]! : rawOutput);
  } catch (error) {
    return {
      ok: false,
      error: `Output is not valid JSON: ${(error as Error).message}`,
    };
  }
  const result = Classification.safeParse(json);
  return result.success
    ? { ok: true, facts: result.data }
    : { ok: false, error: z.prettifyError(result.error) };
}

export async function classifyTicket(
  db: Db,
  classifier: Classifier,
  job: ClassifyJob,
): Promise<void> {
  const [ticket] = await db
    .select()
    .from(tickets)
    .where(eq(tickets.id, job.ticketId));
  if (!ticket) throw new Error(`Ticket ${job.ticketId} not found`);
  if (ticket.classificationState === "classified") return;

  const attempts: Attempt[] = [];
  const isFinalTry = job.attempts >= job.maxAttempts;
  let providerError: ClassifierProviderError | undefined;

  // Records every call made, valid or not, and returns what it produced.
  async function call(
    kind: Attempt["kind"],
    input: ClassifierInput,
  ): Promise<Parsed | "provider_error"> {
    const started = Date.now();
    try {
      const { rawOutput } = await classifier.classify(input);
      const parsed = parseClassification(rawOutput);
      attempts.push({
        kind,
        outcome: parsed.ok ? "valid" : "invalid_output",
        rawOutput,
        parsed: parsed.ok ? parsed.facts : undefined,
        error: parsed.ok ? undefined : parsed.error,
        latencyMs: Date.now() - started,
      });
      return parsed;
    } catch (error) {
      if (!(error instanceof ClassifierProviderError)) throw error;
      attempts.push({
        kind,
        outcome: "provider_error",
        error: error.message,
        latencyMs: Date.now() - started,
      });
      providerError = error;
      return "provider_error";
    }
  }

  const request = { title: ticket.title, description: ticket.description };
  const firstKind =
    ticket.classificationState === "needs_review" ? "rerun" : "initial";
  let outcome = await call(firstKind, request);
  if (outcome !== "provider_error" && !outcome.ok) {
    outcome = await call("repair", {
      ...request,
      repair: {
        previousOutput: attempts.at(-1)!.rawOutput!,
        error: outcome.error,
      },
    });
  }

  if (outcome === "provider_error") {
    const error = providerError!;
    const lostRace = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(tickets)
        .where(eq(tickets.id, ticket.id))
        .for("update");
      // Another worker finished this Ticket while the provider call ran.
      if (locked!.classificationState === "classified") return true;
      await recordAttempts(tx, ticket.id, classifier, attempts);
      if (isFinalTry) {
        await sendToReview(
          tx,
          locked!,
          `AI unavailable after ${job.attempts} attempts: ${error.message}`,
        );
      }
      return false;
    });
    if (lostRace) return;
    // Not final: the throw makes the worker retry with backoff.
    if (!isFinalTry) throw error;
    return;
  }

  await db.transaction(async (tx) => {
    // Another worker may have finished this Ticket while the provider call ran.
    const [locked] = await tx
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticket.id))
      .for("update");
    if (locked!.classificationState === "classified") return;

    await recordAttempts(tx, ticket.id, classifier, attempts);
    if (!outcome.ok) {
      await sendToReview(
        tx,
        locked!,
        `Invalid AI output after one repair: ${outcome.error}`,
      );
      return;
    }
    await applyClassification(tx, locked!, outcome.facts);
  });
}

async function recordAttempts(
  tx: Tx,
  ticketId: string,
  classifier: Classifier,
  attempts: Attempt[],
) {
  const [{ last }] = (await tx
    .select({ last: max(classificationAttempts.attemptNo) })
    .from(classificationAttempts)
    .where(eq(classificationAttempts.ticketId, ticketId))) as [
    { last: number | null },
  ];
  let attemptNo = last ?? 0;
  for (const a of attempts) {
    attemptNo += 1;
    await tx.insert(classificationAttempts).values({
      ticketId,
      attemptNo,
      kind: a.kind,
      outcome: a.outcome,
      provider: classifier.provider,
      model: classifier.model,
      rawOutput: a.rawOutput,
      parsed: a.parsed,
      error: a.error,
      latencyMs: a.latencyMs,
    });
    await appendTicketEvent(tx, ticketId, systemActor, {
      type: "classification_attempted",
      data: {
        attemptNo,
        kind: a.kind,
        outcome: a.outcome,
        provider: classifier.provider,
        model: classifier.model,
        error: a.error ?? null,
      },
    });
  }
}

type TicketRow = typeof tickets.$inferSelect;

async function sendToReview(tx: Tx, ticket: TicketRow, reason: string) {
  const event = await moveClassificationState(tx, ticket, "needs_review", {
    actor: systemActor,
    event: { type: "sent_to_review", data: { reason } },
  });
  await notifyQueueEntry(tx, event, ticket, ticketTeam(ticket), systemActor);
}

async function applyClassification(
  tx: Tx,
  ticket: TicketRow,
  facts: Classification,
) {
  const evaluation = evaluatePriority(facts);
  const team = teamFor(facts.category);
  const dispatchable = isDispatchable(facts.category);
  const nextState = dispatchable ? "classified" : "needs_review";

  const classified = await moveClassificationState(tx, ticket, nextState, {
    set: {
      category: facts.category,
      summary: facts.summary,
      blocksWork: facts.blocks_work,
      impactScope: facts.impact_scope,
      classificationSource: "ai",
      priority: evaluation.priority,
      computedPriority: evaluation.priority,
      priorityRule: evaluation.rule,
      team,
    },
    actor: systemActor,
    event: { type: "classified", data: { ...facts, team } },
  });
  await appendTicketEvent(tx, ticket.id, systemActor, {
    type: "priority_computed",
    data: evaluation,
  });
  await notifyQueueEntry(tx, classified, ticket, team, systemActor);

  if (!dispatchable) {
    await sendToReview(
      tx,
      {
        ...ticket,
        classificationState: nextState,
        category: facts.category,
        team,
      },
      `Category "${facts.category}" is not dispatched automatically`,
    );
    return;
  }

  await createDispatch(tx, ticket.id, {
    category: facts.category,
    priority: evaluation.priority,
    team,
  });
}
