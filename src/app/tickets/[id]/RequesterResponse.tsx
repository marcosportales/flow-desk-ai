"use client";

import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { requesterStatusAction } from "./actions";
import { ActionForm } from "./ManualActions";

// The only control a Requester-only User gets: confirm the fix or say it is
// still broken, with a reason that lands in the timeline under their name.
export function RequesterResponse({ ticketId }: { ticketId: string }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {(
        [
          { response: "close", title: "It's fixed", submit: "Close Ticket" },
          {
            response: "reopen",
            title: "It's still broken",
            submit: "Reopen Ticket",
          },
        ] as const
      ).map(({ response, title, submit }) => (
        <ActionForm
          key={response}
          title={title}
          action={requesterStatusAction}
          ticketId={ticketId}
          submit={submit}
        >
          <input type="hidden" name="response" value={response} />
          <Field>
            <FieldLabel htmlFor={`${response}-reason`}>Reason</FieldLabel>
            <Input
              id={`${response}-reason`}
              name="reason"
              required
              maxLength={500}
            />
          </Field>
        </ActionForm>
      ))}
    </div>
  );
}
