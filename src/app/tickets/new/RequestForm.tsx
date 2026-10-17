"use client";

import { useActionState } from "react";
import { type SubmitRequestState, submitRequest } from "./actions";

type Props = {
  requesters: { id: string; name: string; department: string }[];
  // Generated per render of the page, so every click on the same form carries
  // the same key.
  idempotencyKey: string;
};

export function RequestForm({ requesters, idempotencyKey }: Props) {
  const [state, action, pending] = useActionState<SubmitRequestState, FormData>(
    submitRequest,
    { status: "idle" },
  );

  if (state.status === "created") {
    return (
      <p role="status">
        Ticket #{state.ticketNumber} created.{" "}
        <a href="/tickets/new">Submit another Request</a>
      </p>
    );
  }

  const errors = state.status === "error" ? state.fieldErrors : undefined;

  return (
    <form action={action}>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {state.status === "error" && <p role="alert">{state.message}</p>}
      <p>
        <label>
          Requester
          <select name="requesterId" required defaultValue="">
            <option value="" disabled>
              Select a Requester
            </option>
            {requesters.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} ({r.department})
              </option>
            ))}
          </select>
        </label>
        {errors?.requesterId && (
          <span role="alert">{errors.requesterId[0]}</span>
        )}
      </p>
      <p>
        <label>
          Title
          <input name="title" required minLength={3} maxLength={200} />
        </label>
        {errors?.title && <span role="alert">{errors.title[0]}</span>}
      </p>
      <p>
        <label>
          Description
          <textarea
            name="description"
            required
            minLength={10}
            maxLength={5000}
            rows={6}
          />
        </label>
        {errors?.description && (
          <span role="alert">{errors.description[0]}</span>
        )}
      </p>
      <button type="submit" disabled={pending}>
        {pending ? "Submitting…" : "Submit Request"}
      </button>
    </form>
  );
}
