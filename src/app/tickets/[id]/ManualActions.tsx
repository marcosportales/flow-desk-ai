"use client";

import { type ReactNode, useActionState } from "react";
import { categories, impactScopes } from "@/domain/classification";
import { priorities } from "@/domain/priority";
import { ticketStatuses } from "@/domain/transitions";
import {
  classifyAction,
  type ManualActionState,
  overrideAction,
  rerunAction,
  retryAction,
  statusAction,
} from "./actions";

type Props = {
  ticketId: string;
  ticketStatus: (typeof ticketStatuses)[number];
  classificationState: "pending" | "classified" | "needs_review";
  priority: string | null;
  // The latest Dispatch, when it failed and has not been superseded.
  failedDispatchId: string | null;
};

const idle: ManualActionState = { status: "idle" };
const field = "rounded-md border border-slate-300 px-2 py-1 text-sm";
const button =
  "rounded-md bg-slate-800 px-3 py-1 text-sm text-white disabled:opacity-50";
const label = (value: string) => value.replaceAll("_", " ");

function ActionForm({
  title,
  action,
  ticketId,
  submit,
  children,
}: {
  title: string;
  action: (
    previous: ManualActionState,
    data: FormData,
  ) => Promise<ManualActionState>;
  ticketId: string;
  submit: string;
  children?: ReactNode;
}) {
  const [state, run, pending] = useActionState(action, idle);
  return (
    <form
      action={run}
      className="space-y-2 rounded-md border border-slate-200 p-3"
    >
      <h3 className="font-medium">{title}</h3>
      <input type="hidden" name="ticketId" value={ticketId} />
      {children}
      <button type="submit" disabled={pending} className={button}>
        {submit}
      </button>
      {state.status === "error" && (
        <p role="alert" className="text-sm text-red-800">
          {state.message}
        </p>
      )}
      {state.status === "ok" && (
        <p role="status" className="text-sm text-green-800">
          {state.message}
        </p>
      )}
    </form>
  );
}

export function ManualActions({
  ticketId,
  ticketStatus,
  classificationState,
  priority,
  failedDispatchId,
}: Props) {
  const canClassify =
    classificationState === "needs_review" ||
    classificationState === "classified";
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {classificationState === "needs_review" && (
        <ActionForm
          title="Re-run AI"
          action={rerunAction}
          ticketId={ticketId}
          submit="Re-run AI classification"
        />
      )}
      {canClassify && (
        <ActionForm
          title="Classify manually"
          action={classifyAction}
          ticketId={ticketId}
          submit="Save classification"
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="text-sm">
              Category
              <select name="category" required className={`${field} w-full`}>
                {categories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              Impact Scope
              <select name="impact_scope" className={`${field} w-full`}>
                {impactScopes.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block text-sm">
            Summary
            <input
              name="summary"
              required
              maxLength={200}
              className={`${field} w-full`}
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="blocks_work" value="yes" />
            Blocks work
          </label>
          <label className="block text-sm">
            Reason
            <input
              name="reason"
              required
              maxLength={500}
              className={`${field} w-full`}
            />
          </label>
        </ActionForm>
      )}
      {classificationState === "classified" && (
        <ActionForm
          title="Priority Override"
          action={overrideAction}
          ticketId={ticketId}
          submit="Override Priority"
        >
          <label className="block text-sm">
            Priority
            <select
              name="priority"
              defaultValue={priority ?? undefined}
              className={`${field} w-full`}
            >
              {priorities.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            Reason (required)
            <input
              name="reason"
              required
              maxLength={500}
              className={`${field} w-full`}
            />
          </label>
        </ActionForm>
      )}
      <ActionForm
        title="Ticket Status"
        action={statusAction}
        ticketId={ticketId}
        submit="Change status"
      >
        <label className="block text-sm">
          Status
          <select
            name="status"
            defaultValue={ticketStatus}
            className={`${field} w-full`}
          >
            {ticketStatuses.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </select>
        </label>
      </ActionForm>
      {failedDispatchId && (
        <ActionForm
          title="Retry Dispatch"
          action={retryAction}
          ticketId={ticketId}
          submit="Retry Dispatch"
        >
          <input type="hidden" name="dispatchId" value={failedDispatchId} />
          <p className="text-sm text-slate-600">
            The latest Dispatch failed. Retrying keeps its id, so the notifier
            sees the same idempotency key.
          </p>
        </ActionForm>
      )}
    </div>
  );
}
