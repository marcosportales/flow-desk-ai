"use client";

import { useActionState } from "react";
import { AlertCircleIcon } from "lucide-react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { type SignInState, signInWithPassword } from "./actions";

export function SignInForm() {
  const [state, action, pending] = useActionState<SignInState, FormData>(
    signInWithPassword,
    { status: "idle" },
  );

  return (
    <form action={action}>
      <FieldGroup>
        {state.status === "error" && (
          <Alert variant="destructive" role="alert">
            <AlertCircleIcon />
            <AlertTitle>{state.message}</AlertTitle>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input id="email" name="email" type="email" required />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input id="password" name="password" type="password" required />
        </Field>
        <Button type="submit" disabled={pending} className="self-start">
          {pending && <Spinner data-icon="inline-start" />}
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </FieldGroup>
    </form>
  );
}
