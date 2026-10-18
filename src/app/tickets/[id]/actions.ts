"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { type Actor, userActor } from "@/domain/actor";
import { requireUser } from "@/infra/auth/session";
import { getDb } from "@/infra/db/client";
import {
  reassignTicket,
  releaseTicket,
  takeTicket,
} from "@/services/assignTicket";
import {
  authorizeManualAction,
  authorizeRequesterResponse,
} from "@/services/authorizeManualAction";
import { respondToResolution } from "@/services/respondToResolution";
import { changeTicketStatus } from "@/services/changeTicketStatus";
import { classifyManually } from "@/services/classifyManually";
import { overridePriority } from "@/services/overridePriority";
import { rerunClassification } from "@/services/rerunClassification";
import { retryDispatch } from "@/services/retryDispatch";

// Server Actions behind the manual action controls on the Ticket page. They
// call the same services as the API routes (IMPLEMENTATION.md §4.7, §8).

export type ManualActionState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string };

type Outcome = { kind: string; message?: string; details?: unknown };

const text = (data: FormData, name: string) => {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
};

const forbidden: ManualActionState = {
  status: "error",
  message: "Only an Operator of the Ticket's Team can run Manual Actions",
};

// Checks the signed-in User may run Manual Actions on the Ticket (ADR 0008),
// and names them as the actor of the resulting events.
async function authorize(
  target: { ticketId: string } | { dispatchId: string },
): Promise<{ denied: ManualActionState } | { actor: Actor }> {
  const user = await requireUser();
  const verdict = await authorizeManualAction(getDb(), user.id, target);
  if (verdict === "forbidden") return { denied: forbidden };
  if (verdict === "not_found") return { denied: unknownTicket };
  return { actor: userActor(user.id) };
}

const unknownTicket: ManualActionState = {
  status: "error",
  message: "Unknown Ticket",
};

function settle(
  ticketId: string,
  result: Outcome,
  success: string,
): ManualActionState {
  switch (result.kind) {
    case "ok":
    case "queued":
      revalidatePath(`/tickets/${ticketId}`);
      revalidatePath("/tickets");
      return { status: "ok", message: success };
    case "invalid": {
      const { fieldErrors, formErrors } = result.details as {
        fieldErrors: Record<string, string[] | undefined>;
        formErrors: string[];
      };
      const messages = [
        ...formErrors,
        ...Object.entries(fieldErrors).map(
          ([field, errors]) => `${field}: ${errors?.[0] ?? "invalid"}`,
        ),
      ];
      return {
        status: "error",
        message: messages.join("; ") || "Invalid input",
      };
    }
    case "not_found":
      return { status: "error", message: "Unknown Ticket" };
    case "already_queued":
      return { status: "error", message: "A re-run is already queued" };
    case "not_retryable":
    case "not_rerunnable":
      return {
        status: "error",
        message: "The Ticket is not in a state that allows this action",
      };
    default:
      return {
        status: "error",
        message: result.message ?? "The action is not allowed right now",
      };
  }
}

export async function classifyAction(
  _previous: ManualActionState,
  data: FormData,
): Promise<ManualActionState> {
  const ticketId = text(data, "ticketId");
  if (!z.uuid().safeParse(ticketId).success) return unknownTicket;
  const operator = await authorize({ ticketId });
  if ("denied" in operator) return operator.denied;
  const result = await classifyManually(
    getDb(),
    ticketId,
    {
      category: text(data, "category"),
      summary: text(data, "summary"),
      blocks_work: data.get("blocks_work") === "yes",
      impact_scope: text(data, "impact_scope"),
      reason: text(data, "reason"),
    },
    operator.actor,
  );
  return settle(ticketId, result, "Classification saved");
}

export async function rerunAction(
  _previous: ManualActionState,
  data: FormData,
): Promise<ManualActionState> {
  const ticketId = text(data, "ticketId");
  if (!z.uuid().safeParse(ticketId).success) return unknownTicket;
  const operator = await authorize({ ticketId });
  if ("denied" in operator) return operator.denied;
  const result = await rerunClassification(getDb(), ticketId, operator.actor);
  return settle(ticketId, result, "AI re-run queued");
}

export async function overrideAction(
  _previous: ManualActionState,
  data: FormData,
): Promise<ManualActionState> {
  const ticketId = text(data, "ticketId");
  if (!z.uuid().safeParse(ticketId).success) return unknownTicket;
  const operator = await authorize({ ticketId });
  if ("denied" in operator) return operator.denied;
  const result = await overridePriority(
    getDb(),
    ticketId,
    {
      priority: text(data, "priority"),
      reason: text(data, "reason"),
    },
    operator.actor,
  );
  return settle(ticketId, result, "Priority Override saved");
}

export async function statusAction(
  _previous: ManualActionState,
  data: FormData,
): Promise<ManualActionState> {
  const ticketId = text(data, "ticketId");
  if (!z.uuid().safeParse(ticketId).success) return unknownTicket;
  const operator = await authorize({ ticketId });
  if ("denied" in operator) return operator.denied;
  const result = await changeTicketStatus(
    getDb(),
    ticketId,
    {
      status: text(data, "status"),
    },
    operator.actor,
  );
  return settle(ticketId, result, "Ticket Status changed");
}

// The Requester's own control: close ("fixed") or reopen ("still broken").
export async function requesterStatusAction(
  _previous: ManualActionState,
  data: FormData,
): Promise<ManualActionState> {
  const ticketId = text(data, "ticketId");
  if (!z.uuid().safeParse(ticketId).success) return unknownTicket;
  const user = await requireUser();
  const verdict = await authorizeRequesterResponse(getDb(), user.id, ticketId);
  if (verdict === "not_found") return unknownTicket;
  if (verdict === "forbidden") {
    return {
      status: "error",
      message: "Only the Ticket's Requester can close or reopen it",
    };
  }
  const result = await respondToResolution(
    getDb(),
    ticketId,
    { response: text(data, "response"), reason: text(data, "reason") },
    userActor(user.id),
  );
  return settle(
    ticketId,
    result,
    text(data, "response") === "close" ? "Ticket closed" : "Ticket reopened",
  );
}

export async function retryAction(
  _previous: ManualActionState,
  data: FormData,
): Promise<ManualActionState> {
  const ticketId = text(data, "ticketId");
  if (!z.uuid().safeParse(ticketId).success) return unknownTicket;
  const dispatchId = text(data, "dispatchId");
  if (!z.uuid().safeParse(dispatchId).success) {
    return { status: "error", message: "Unknown Dispatch" };
  }
  // The form's ticketId is untrusted: authorize through the Dispatch itself.
  const operator = await authorize({ dispatchId });
  if ("denied" in operator) return operator.denied;
  const result = await retryDispatch(getDb(), dispatchId, operator.actor);
  return settle(ticketId, result, "Dispatch retry queued");
}

export async function takeAction(
  _previous: ManualActionState,
  data: FormData,
): Promise<ManualActionState> {
  const ticketId = text(data, "ticketId");
  if (!z.uuid().safeParse(ticketId).success) return unknownTicket;
  const operator = await authorize({ ticketId });
  if ("denied" in operator) return operator.denied;
  const result = await takeTicket(getDb(), ticketId, operator.actor);
  return settle(ticketId, result, "You took the Ticket");
}

export async function releaseAction(
  _previous: ManualActionState,
  data: FormData,
): Promise<ManualActionState> {
  const ticketId = text(data, "ticketId");
  if (!z.uuid().safeParse(ticketId).success) return unknownTicket;
  const operator = await authorize({ ticketId });
  if ("denied" in operator) return operator.denied;
  const result = await releaseTicket(getDb(), ticketId, operator.actor);
  return settle(ticketId, result, "Ticket released to the queue");
}

export async function reassignAction(
  _previous: ManualActionState,
  data: FormData,
): Promise<ManualActionState> {
  const ticketId = text(data, "ticketId");
  if (!z.uuid().safeParse(ticketId).success) return unknownTicket;
  const operator = await authorize({ ticketId });
  if ("denied" in operator) return operator.denied;
  const result = await reassignTicket(
    getDb(),
    ticketId,
    { assigneeId: text(data, "assigneeId") },
    operator.actor,
  );
  return settle(ticketId, result, "Ticket reassigned");
}
