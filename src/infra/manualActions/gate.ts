import { revalidatePath } from "next/cache";
import { type Actor, userActor } from "@/domain/actor";
import { getDb } from "@/infra/db/client";
import {
  authorizeManualAction,
  authorizeRequesterResponse,
  ticketOfDispatch,
} from "@/services/authorizeManualAction";
import type { Db } from "@/services/createTicket";

// The one way to run a Manual Action (ADR 0010): authorize the
// caller (ADR 0008), run the service with the User as actor, and revalidate
// the Ticket pages on success. The route and Server Action adapters only
// translate requests and outcomes; `tests/manualActionArchitecture.test.ts`
// fails if a Manual Action route or Server Action bypasses them.

// Who may run it: an Operator of the Ticket's Team, or the Ticket's own
// Requester (close and reopen).
export type ManualActionCaller = "operator" | "requester";

export type Outcome = {
  kind: string;
  message?: string;
  details?: unknown;
  status?: string;
};

export type ManualAction<Input> = {
  readonly caller: ManualActionCaller;
  // What the id names: a Ticket, or a Dispatch checked through its Ticket.
  readonly target: "ticket" | "dispatch";
  readonly run: (
    db: Db,
    id: string,
    input: Input,
    actor: Actor,
  ) => Promise<Outcome>;
};

export function defineManualAction<Input = void>(
  action: ManualAction<Input>,
): ManualAction<Input> {
  return action;
}

export const forbiddenMessage: Record<ManualActionCaller, string> = {
  operator: "Only an Operator of the Ticket's Team can run Manual Actions",
  requester: "Only the Ticket's Requester can close or reopen it",
};

// Returned by `readInput` when the request carries no usable input.
export const unreadable = Symbol("unreadable");

export type GateOutcome =
  | Outcome
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "unreadable" };

export async function performManualAction<Input>(
  action: ManualAction<Input>,
  {
    userId,
    id,
    readInput,
  }: {
    userId: string;
    id: string;
    readInput: () => Promise<Input | typeof unreadable>;
  },
): Promise<GateOutcome> {
  const db = getDb();
  const ticketId =
    action.target === "ticket" ? id : await ticketOfDispatch(db, id);
  if (!ticketId) return { kind: "not_found" };

  const verdict =
    action.caller === "operator"
      ? await authorizeManualAction(db, userId, { ticketId })
      : await authorizeRequesterResponse(db, userId, ticketId);
  if (verdict !== "allowed") return { kind: verdict };

  const input = await readInput();
  if (input === unreadable) return { kind: "unreadable" };

  const result = await action.run(db, id, input, userActor(userId));
  if (result.kind === "ok" || result.kind === "queued") {
    revalidatePath(`/tickets/${ticketId}`);
    revalidatePath("/tickets");
  }
  return result;
}
