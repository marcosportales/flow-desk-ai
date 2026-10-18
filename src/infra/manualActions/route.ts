import { z } from "zod";
import { errorResponse } from "@/infra/api/errors";
import { getRequestUser } from "@/infra/auth/session";
import {
  forbiddenMessage,
  type GateOutcome,
  type ManualAction,
  type ManualActionCaller,
  performManualAction,
  unreadable,
} from "./gate";

// Turns a Manual Action into the `POST` handler of an API route
// (IMPLEMENTATION.md §4.7, §7): session, id and JSON body checks, then the
// outcome as a response. Every `POST` under `src/app/api/tickets/[id]/` and
// `src/app/api/dispatches/[id]/` is `export const POST = manualActionRoute(…)`.

type RouteContext = { params: Promise<{ id: string }> };

// Manual Actions need a User session (ADR 0008): no session is 401, and an
// Integration's API key never substitutes for one (403).
const signedOut: Record<
  ManualActionCaller,
  { apiKey: string; anonymous: string }
> = {
  operator: {
    apiKey:
      "Manual Actions require an Operator session; the API key cannot run them",
    anonymous: "Sign in as an Operator",
  },
  requester: {
    apiKey:
      "Closing or reopening requires the Requester's session; the API key cannot do it",
    anonymous: "Sign in as the Requester",
  },
};

const conflictCodes = new Set([
  "illegal_state",
  "illegal_transition",
  "not_rerunnable",
  "already_queued",
  "already_assigned",
]);

export function manualActionRoute<Input>(
  action: ManualAction<Input>,
  {
    withBody = true,
    successStatus = 200,
    successBody = (id) =>
      action.target === "ticket" ? { ticketId: id } : { dispatchId: id },
  }: {
    withBody?: boolean;
    successStatus?: number;
    successBody?: (id: string) => object;
  } = {},
): (request: Request, context: RouteContext) => Promise<Response> {
  const unknown =
    action.target === "ticket" ? "Unknown ticket" : "Unknown dispatch";

  return async (request, { params }) => {
    const { id } = await params;
    if (!z.uuid().safeParse(id).success) {
      return errorResponse(404, "not_found", unknown);
    }
    const user = await getRequestUser(request);
    if (!user) {
      const messages = signedOut[action.caller];
      return request.headers.get("x-api-key")
        ? errorResponse(403, "forbidden", messages.apiKey)
        : errorResponse(401, "unauthorized", messages.anonymous);
    }

    const result: GateOutcome = await performManualAction(action, {
      userId: user.id,
      id,
      readInput: async () => {
        if (!withBody) return undefined as Input;
        try {
          return (await request.json()) as Input;
        } catch {
          return unreadable;
        }
      },
    });

    switch (result.kind) {
      case "ok":
      case "queued":
        return Response.json(successBody(id), { status: successStatus });
      case "forbidden":
        return errorResponse(403, "forbidden", forbiddenMessage[action.caller]);
      case "not_found":
        return errorResponse(404, "not_found", unknown);
      case "unreadable":
        return errorResponse(
          422,
          "validation_error",
          "Body must be valid JSON",
        );
      case "invalid":
        return errorResponse(
          422,
          "validation_error",
          "Invalid request",
          "details" in result ? result.details : undefined,
        );
      case "not_retryable":
        return errorResponse(
          409,
          "not_retryable",
          `Only a failed Dispatch can be retried; this one is ${"status" in result ? result.status : "not failed"}`,
        );
    }
    if (conflictCodes.has(result.kind)) {
      return errorResponse(
        409,
        result.kind === "illegal_transition" ? result.kind : "conflict",
        ("message" in result ? result.message : undefined) ??
          "The Ticket is not in a state that allows this action",
      );
    }
    throw new Error(`Unhandled action result: ${result.kind}`);
  };
}
