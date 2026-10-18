"use server";

import { userActor } from "@/domain/actor";
import { requireUser } from "@/infra/auth/session";
import { getDb } from "@/infra/db/client";
import { createTicket } from "@/services/createTicket";

export type SubmitRequestState =
  | { status: "idle" }
  | { status: "created"; ticketId: string; ticketNumber: number }
  | {
      status: "error";
      message: string;
      fieldErrors?: Record<string, string[] | undefined>;
    };

const text = (data: FormData, name: string) => {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
};

export async function submitRequest(
  _previous: SubmitRequestState,
  data: FormData,
): Promise<SubmitRequestState> {
  // The Requester is whoever is signed in, never a form field.
  const user = await requireUser();
  const result = await createTicket(
    getDb(),
    {
      requesterId: user.id,
      title: text(data, "title"),
      description: text(data, "description"),
      idempotencyKey: text(data, "idempotencyKey"),
    },
    userActor(user.id),
  );

  switch (result.kind) {
    case "created":
    case "replayed":
      return {
        status: "created",
        ticketId: result.ticket.id,
        ticketNumber: result.ticket.number!,
      };
    case "conflict":
      return {
        status: "error",
        message:
          "This form was already submitted with different content. Reload it to submit a new Request.",
      };
    case "invalid": {
      const { fieldErrors } = result.details as {
        fieldErrors: Record<string, string[] | undefined>;
      };
      return {
        status: "error",
        message: "Please fix the errors below.",
        fieldErrors,
      };
    }
  }
}
