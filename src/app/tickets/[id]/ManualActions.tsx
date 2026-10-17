"use client";

import { type ReactNode, useActionState } from "react";
import { AlertCircleIcon, CheckCircle2Icon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
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
import { label } from "@/lib/format";

type Props = {
  ticketId: string;
  ticketStatus: (typeof ticketStatuses)[number];
  classificationState: "pending" | "classified" | "needs_review";
  priority: string | null;
  // The latest Dispatch, when it failed and has not been superseded.
  failedDispatchId: string | null;
};

const idle: ManualActionState = { status: "idle" };
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
    <form action={run}>
      <Card size="sm">
        <CardHeader>
          <CardTitle>
            <h3>{title}</h3>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <input type="hidden" name="ticketId" value={ticketId} />
          <FieldGroup className="gap-3">{children}</FieldGroup>
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-2">
          <Button type="submit" disabled={pending} className="self-start">
            {pending && <Spinner data-icon="inline-start" />}
            {submit}
          </Button>
          {state.status === "error" && (
            <Alert variant="destructive" role="alert">
              <AlertCircleIcon />
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          )}
          {state.status === "ok" && (
            <Alert role="status">
              <CheckCircle2Icon />
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          )}
        </CardFooter>
      </Card>
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
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="classify-category">Category</FieldLabel>
              <NativeSelect
                id="classify-category"
                name="category"
                required
                className="w-full"
              >
                {categories.map((c) => (
                  <NativeSelectOption key={c} value={c}>
                    {c}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="classify-impact-scope">
                Impact Scope
              </FieldLabel>
              <NativeSelect
                id="classify-impact-scope"
                name="impact_scope"
                className="w-full"
              >
                {impactScopes.map((s) => (
                  <NativeSelectOption key={s} value={s}>
                    {s}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <Field>
            <FieldLabel htmlFor="classify-summary">Summary</FieldLabel>
            <Input
              id="classify-summary"
              name="summary"
              required
              maxLength={200}
            />
          </Field>
          <Field orientation="horizontal">
            <Checkbox
              id="classify-blocks-work"
              name="blocks_work"
              value="yes"
            />
            <FieldLabel htmlFor="classify-blocks-work">Blocks work</FieldLabel>
          </Field>
          <Field>
            <FieldLabel htmlFor="classify-reason">Reason</FieldLabel>
            <Input
              id="classify-reason"
              name="reason"
              required
              maxLength={500}
            />
          </Field>
        </ActionForm>
      )}
      {classificationState === "classified" && (
        <ActionForm
          title="Priority Override"
          action={overrideAction}
          ticketId={ticketId}
          submit="Override Priority"
        >
          <Field>
            <FieldLabel htmlFor="override-priority">Priority</FieldLabel>
            <NativeSelect
              id="override-priority"
              name="priority"
              defaultValue={priority ?? undefined}
              className="w-full"
            >
              {priorities.map((p) => (
                <NativeSelectOption key={p} value={p}>
                  {p}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field>
            <FieldLabel htmlFor="override-reason">Reason (required)</FieldLabel>
            <Input
              id="override-reason"
              name="reason"
              required
              maxLength={500}
            />
          </Field>
        </ActionForm>
      )}
      <ActionForm
        title="Ticket Status"
        action={statusAction}
        ticketId={ticketId}
        submit="Change status"
      >
        <Field>
          <FieldLabel htmlFor="status-select">Status</FieldLabel>
          <NativeSelect
            id="status-select"
            name="status"
            defaultValue={ticketStatus}
            className="w-full"
          >
            {ticketStatuses.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {label(s)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </ActionForm>
      {failedDispatchId && (
        <ActionForm
          title="Retry Dispatch"
          action={retryAction}
          ticketId={ticketId}
          submit="Retry Dispatch"
        >
          <input type="hidden" name="dispatchId" value={failedDispatchId} />
          <p className="text-sm text-muted-foreground">
            The latest Dispatch failed. Retrying keeps its id, so the notifier
            sees the same idempotency key.
          </p>
        </ActionForm>
      )}
    </div>
  );
}
