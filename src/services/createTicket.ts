import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { Actor } from "@/domain/actor";
import * as schema from "@/infra/db/schema";
import { jobs, users, tickets } from "@/infra/db/schema";
import { appendTicketEvent } from "./ticketWrites";

// Any Drizzle Postgres database over this schema.
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export type Ticket = typeof tickets.$inferSelect;

export const createTicketInput = z.object({
  requesterId: z.uuid(),
  idempotencyKey: z.string().min(1).max(255),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(10).max(5000),
});

export type CreateTicketResult =
  | { kind: "created"; ticket: Ticket }
  | { kind: "replayed"; ticket: Ticket }
  | { kind: "conflict" }
  | { kind: "invalid"; details: unknown };

// The key is not part of the hash: it identifies the submission, the hash
// identifies what was submitted.
function hashRequest(input: {
  requesterId: string;
  title: string;
  description: string;
}) {
  return createHash("sha256")
    .update(JSON.stringify([input.requesterId, input.title, input.description]))
    .digest("hex");
}

export async function createTicket(
  db: Db,
  rawInput: unknown,
  actor: Actor,
): Promise<CreateTicketResult> {
  const parsed = createTicketInput.safeParse(rawInput);
  if (!parsed.success) {
    return { kind: "invalid", details: z.flattenError(parsed.error) };
  }
  const input = parsed.data;
  const requestHash = hashRequest(input);

  return db.transaction(async (tx) => {
    const [requester] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.requesterId));
    if (!requester) {
      return {
        kind: "invalid",
        details: { fieldErrors: { requesterId: ["Unknown requester"] } },
      } as const;
    }

    const [inserted] = await tx
      .insert(tickets)
      .values({
        requesterId: input.requesterId,
        title: input.title,
        description: input.description,
        idempotencyKey: input.idempotencyKey,
        requestHash,
      })
      .onConflictDoNothing({
        target: [tickets.requesterId, tickets.idempotencyKey],
      })
      .returning();

    if (!inserted) {
      const [existing] = await tx
        .select()
        .from(tickets)
        .where(
          and(
            eq(tickets.requesterId, input.requesterId),
            eq(tickets.idempotencyKey, input.idempotencyKey),
          ),
        );
      return existing!.requestHash === requestHash
        ? ({ kind: "replayed", ticket: existing! } as const)
        : ({ kind: "conflict" } as const);
    }

    await appendTicketEvent(tx, inserted.id, actor, {
      type: "ticket_created",
      data: { requesterId: input.requesterId },
    });
    await tx.insert(jobs).values({ kind: "classify", ticketId: inserted.id });
    return { kind: "created", ticket: inserted } as const;
  });
}
