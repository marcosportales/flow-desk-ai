"use server";

import {
  changeStatus,
  classify,
  overridePriorityAction,
  reassign,
  release,
  respond,
  rerun,
  retry,
  take,
} from "@/infra/manualActions/catalog";
import { formText as text, manualActionForm } from "@/infra/manualActions/form";

// Server Actions behind the manual action controls on the Ticket page. They
// run the same Manual Actions as the API routes (IMPLEMENTATION.md §4.7, §8).

export type { ManualActionState } from "@/infra/manualActions/form";

export const classifyAction = manualActionForm(classify, {
  input: (data) => ({
    category: text(data, "category"),
    summary: text(data, "summary"),
    blocks_work: data.get("blocks_work") === "yes",
    impact_scope: text(data, "impact_scope"),
    reason: text(data, "reason"),
  }),
  success: "Classification saved",
});

export const rerunAction = manualActionForm(rerun, {
  success: "AI re-run queued",
});

export const overrideAction = manualActionForm(overridePriorityAction, {
  input: (data) => ({
    priority: text(data, "priority"),
    reason: text(data, "reason"),
  }),
  success: "Priority Override saved",
});

export const statusAction = manualActionForm(changeStatus, {
  input: (data) => ({ status: text(data, "status") }),
  success: "Ticket Status changed",
});

// The Requester's own control: close ("fixed") or reopen ("still broken").
export const requesterStatusAction = manualActionForm(respond, {
  input: (data) => ({
    response: text(data, "response"),
    reason: text(data, "reason"),
  }),
  success: (data) =>
    text(data, "response") === "close" ? "Ticket closed" : "Ticket reopened",
});

export const retryAction = manualActionForm(retry, {
  success: "Dispatch retry queued",
});

export const takeAction = manualActionForm(take, {
  success: "You took the Ticket",
});

export const releaseAction = manualActionForm(release, {
  success: "Ticket released to the queue",
});

export const reassignAction = manualActionForm(reassign, {
  input: (data) => ({ assigneeId: text(data, "assigneeId") }),
  success: "Ticket reassigned",
});
