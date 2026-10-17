"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/infra/db/client";
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
  const result = await classifyManually(getDb(), ticketId, {
    category: text(data, "category"),
    summary: text(data, "summary"),
    blocks_work: data.get("blocks_work") === "yes",
    impact_scope: text(data, "impact_scope"),
    reason: text(data, "reason"),
  });
  return settle(ticketId, result, "Classification saved");
}

export async function rerunAction(
  _previous: ManualActionState,
  data: FormData,
): Promise<ManualActionState> {
  const ticketId = text(data, "ticketId");
  if (!z.uuid().safeParse(ticketId).success) return unknownTicket;
  const result = await rerunClassification(getDb(), ticketId);
  return settle(ticketId, result, "AI re-run queued");
}

export async function overrideAction(
  _previous: ManualActionState,
  data: FormData,
): Promise<ManualActionState> {
  const ticketId = text(data, "ticketId");
  if (!z.uuid().safeParse(ticketId).success) return unknownTicket;
  const result = await overridePriority(getDb(), ticketId, {
    priority: text(data, "priority"),
    reason: text(data, "reason"),
  });
  return settle(ticketId, result, "Priority Override saved");
}

export async function statusAction(
  _previous: ManualActionState,
  data: FormData,
): Promise<ManualActionState> {
  const ticketId = text(data, "ticketId");
  if (!z.uuid().safeParse(ticketId).success) return unknownTicket;
  const result = await changeTicketStatus(getDb(), ticketId, {
    status: text(data, "status"),
  });
  return settle(ticketId, result, "Ticket Status changed");
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
  const result = await retryDispatch(getDb(), dispatchId);
  return settle(ticketId, result, "Dispatch retry queued");
}
