import { z } from "zod";
import { requireUser } from "@/infra/auth/session";
import {
  forbiddenMessage,
  type ManualAction,
  performManualAction,
} from "./gate";

// Turns a Manual Action into a Server Action for the Ticket page's forms
// (IMPLEMENTATION.md §8). Every export of `src/app/tickets/[id]/actions.ts`
// is `export const … = manualActionForm(…)`.

export type ManualActionState =
  | { status: "idle" }
  | { status: "ok"; message: string }
  | { status: "error"; message: string };

export function manualActionForm<Input>(
  action: ManualAction<Input>,
  {
    input = () => undefined as Input,
    success,
  }: {
    input?: (data: FormData) => Input;
    success: string | ((data: FormData) => string);
  },
): (previous: ManualActionState, data: FormData) => Promise<ManualActionState> {
  const field = action.target === "ticket" ? "ticketId" : "dispatchId";
  const unknown: ManualActionState = {
    status: "error",
    message: action.target === "ticket" ? "Unknown Ticket" : "Unknown Dispatch",
  };

  return async (_previous, data) => {
    // For a Dispatch, the form's ticketId is untrusted: the gate authorizes
    // and revalidates through the Dispatch itself.
    const id = formText(data, field);
    if (!z.uuid().safeParse(id).success) return unknown;
    const user = await requireUser();

    const result = await performManualAction(action, {
      userId: user.id,
      id,
      readInput: async () => input(data),
    });

    switch (result.kind) {
      case "ok":
      case "queued":
        return {
          status: "ok",
          message: typeof success === "string" ? success : success(data),
        };
      case "forbidden":
        return { status: "error", message: forbiddenMessage[action.caller] };
      case "not_found":
        return unknown;
      case "invalid":
        return { status: "error", message: invalidMessage(result) };
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
          message:
            ("message" in result ? result.message : undefined) ??
            "The action is not allowed right now",
        };
    }
  };
}

export function formText(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

function invalidMessage(result: { details?: unknown }): string {
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
  return messages.join("; ") || "Invalid input";
}
