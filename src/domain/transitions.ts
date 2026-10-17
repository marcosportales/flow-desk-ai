// Status axes and their legal moves: docs/plan/IMPLEMENTATION.md §2.4.

export const ticketStatuses = ["open", "resolved", "closed"] as const;
export type TicketStatus = (typeof ticketStatuses)[number];

export const classificationStates = [
  "pending",
  "classified",
  "needs_review",
] as const;
export type ClassificationState = (typeof classificationStates)[number];

export const dispatchStatuses = [
  "pending",
  "sent",
  "succeeded",
  "failed",
  "unknown",
] as const;
export type DispatchStatus = (typeof dispatchStatuses)[number];

export class IllegalTransitionError extends Error {
  constructor(
    readonly axis: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal ${axis} transition: ${from} → ${to}`);
    this.name = "IllegalTransitionError";
  }
}

type Moves<S extends string> = Record<S, readonly S[]>;

function transition<S extends string>(
  axis: string,
  moves: Moves<S>,
  from: S,
  to: S,
): S {
  if (!moves[from].includes(to)) {
    throw new IllegalTransitionError(axis, from, to);
  }
  return to;
}

const ticketStatusMoves: Moves<TicketStatus> = {
  open: ["resolved"],
  resolved: ["closed", "open"],
  closed: [],
};

export function transitionTicketStatus(
  from: TicketStatus,
  to: TicketStatus,
): TicketStatus {
  return transition("Ticket Status", ticketStatusMoves, from, to);
}

// needs_review → classified covers both manual classification and a re-run;
// classified → classified is a manual correction.
const classificationStateMoves: Moves<ClassificationState> = {
  pending: ["classified", "needs_review"],
  needs_review: ["classified"],
  classified: ["classified"],
};

export function transitionClassificationState(
  from: ClassificationState,
  to: ClassificationState,
): ClassificationState {
  return transition("Classification State", classificationStateMoves, from, to);
}

// pending → failed: n8n never accepted it and the auto-retry budget ran out
// (§4.4). unknown only settles through Reconciliation or a late callback.
// failed → pending is a retry of the same Dispatch.
const dispatchStatusMoves: Moves<DispatchStatus> = {
  pending: ["sent", "failed"],
  sent: ["succeeded", "failed", "unknown"],
  unknown: ["succeeded", "failed"],
  failed: ["pending"],
  succeeded: [],
};

export function transitionDispatchStatus(
  from: DispatchStatus,
  to: DispatchStatus,
): DispatchStatus {
  return transition("Dispatch Status", dispatchStatusMoves, from, to);
}
