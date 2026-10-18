import {
  reassignTicket,
  releaseTicket,
  takeTicket,
} from "@/services/assignTicket";
import { changeTicketStatus } from "@/services/changeTicketStatus";
import { classifyManually } from "@/services/classifyManually";
import { overridePriority } from "@/services/overridePriority";
import { rerunClassification } from "@/services/rerunClassification";
import { respondToResolution } from "@/services/respondToResolution";
import { retryDispatch } from "@/services/retryDispatch";
import type { Actor } from "@/domain/actor";
import type { Db } from "@/services/createTicket";
import { defineManualAction, type Outcome } from "./gate";

// Every Manual Action, shared by the API routes and the Ticket page's Server
// Actions (IMPLEMENTATION.md §4.7). Services validate their own input.

const withoutInput =
  (service: (db: Db, id: string, actor: Actor) => Promise<Outcome>) =>
  (db: Db, id: string, _input: void, actor: Actor) =>
    service(db, id, actor);

export const classify = defineManualAction<unknown>({
  caller: "operator",
  target: "ticket",
  run: classifyManually,
});

export const rerun = defineManualAction({
  caller: "operator",
  target: "ticket",
  run: withoutInput(rerunClassification),
});

export const overridePriorityAction = defineManualAction<unknown>({
  caller: "operator",
  target: "ticket",
  run: overridePriority,
});

export const changeStatus = defineManualAction<unknown>({
  caller: "operator",
  target: "ticket",
  run: changeTicketStatus,
});

export const take = defineManualAction({
  caller: "operator",
  target: "ticket",
  run: withoutInput(takeTicket),
});

export const release = defineManualAction({
  caller: "operator",
  target: "ticket",
  run: withoutInput(releaseTicket),
});

export const reassign = defineManualAction<unknown>({
  caller: "operator",
  target: "ticket",
  run: reassignTicket,
});

export const retry = defineManualAction({
  caller: "operator",
  target: "dispatch",
  run: withoutInput(retryDispatch),
});

// The Requester closes ("fixed") or reopens ("still broken") their own Ticket.
export const respond = defineManualAction<unknown>({
  caller: "requester",
  target: "ticket",
  run: respondToResolution,
});
