"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState } from "react";
import { AlertCircleIcon, CheckCircle2Icon } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
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

  const router = useRouter();

  if (state.status === "created") {
    return (
      <Alert role="status">
        <CheckCircle2Icon />
        <AlertTitle>Ticket #{state.ticketNumber} created.</AlertTitle>
        <AlertDescription>
          <div className="flex gap-4">
            <Link href={`/tickets/${state.ticketId}`} className="underline">
              View ticket
            </Link>
            {/* Same-URL <Link> is a no-op; refreshing re-renders the page with
                a new idempotency key, which remounts the form. */}
            <button
              type="button"
              className="underline"
              onClick={() => router.refresh()}
            >
              Submit another Request
            </button>
          </div>
        </AlertDescription>
      </Alert>
    );
  }

  const errors = state.status === "error" ? state.fieldErrors : undefined;

  return (
    <form action={action}>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <FieldGroup>
        {state.status === "error" && (
          <Alert variant="destructive" role="alert">
            <AlertCircleIcon />
            <AlertTitle>{state.message}</AlertTitle>
          </Alert>
        )}
        <Field data-invalid={!!errors?.requesterId}>
          <FieldLabel htmlFor="requesterId">Requester</FieldLabel>
          <NativeSelect
            id="requesterId"
            name="requesterId"
            required
            defaultValue=""
            aria-invalid={!!errors?.requesterId}
            className="w-full"
          >
            <NativeSelectOption value="" disabled>
              Select a Requester
            </NativeSelectOption>
            {requesters.map((r) => (
              <NativeSelectOption key={r.id} value={r.id}>
                {r.name} ({r.department})
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {errors?.requesterId && (
            <FieldError>{errors.requesterId[0]}</FieldError>
          )}
        </Field>
        <Field data-invalid={!!errors?.title}>
          <FieldLabel htmlFor="title">Title</FieldLabel>
          <Input
            id="title"
            name="title"
            required
            minLength={3}
            maxLength={200}
            aria-invalid={!!errors?.title}
          />
          {errors?.title && <FieldError>{errors.title[0]}</FieldError>}
        </Field>
        <Field data-invalid={!!errors?.description}>
          <FieldLabel htmlFor="description">Description</FieldLabel>
          <Textarea
            id="description"
            name="description"
            required
            minLength={10}
            maxLength={5000}
            rows={6}
            aria-invalid={!!errors?.description}
          />
          {errors?.description && (
            <FieldError>{errors.description[0]}</FieldError>
          )}
        </Field>
        <Button type="submit" disabled={pending} className="self-start">
          {pending && <Spinner data-icon="inline-start" />}
          {pending ? "Submitting…" : "Submit Request"}
        </Button>
      </FieldGroup>
    </form>
  );
}
