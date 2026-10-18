import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { Sql } from "postgres";
import { FakeClassifier } from "@/infra/classifier/fake";
import {
  dispatchAttempts,
  dispatches,
  jobs,
  users,
  ticketEvents,
  tickets,
} from "@/infra/db/schema";
import { classifyTicket } from "@/services/classifyTicket";
import { createTicket } from "@/services/createTicket";
import type { DispatchConfig } from "@/infra/n8n/config";
import { dispatchTicket } from "@/services/dispatchTicket";
import { reconcileDispatch } from "@/services/reconcileDispatch";
import { runNextJob } from "@/worker/runner";
import type { TestDb } from "./db";

export const TO_N8N_SECRET = "flowdesk-to-n8n";
export const FROM_N8N_SECRET = "n8n-to-flowdesk";

const ERP_BLOCKER =
  "I haven't been able to access SAP since this morning, and I need to process some invoices.";

export function dispatchConfig(webhookUrl: string): DispatchConfig {
  return {
    webhookUrl,
    secret: TO_N8N_SECRET,
    callbackUrl: "http://app:3000/api/webhooks/n8n",
    callbackTimeoutSeconds: 60,
  };
}

export function dispatchFixtures(db: TestDb, sql: Sql) {
  // A classified ERP blocker with its pending Dispatch and queued dispatch job.
  async function classifiedTicket() {
    const [requester] = await db
      .insert(users)
      .values({
        name: "Dispatch Test",
        email: `${randomUUID()}@test.example`,
        department: "QA",
      })
      .returning();
    const result = await createTicket(db, {
      requesterId: requester!.id,
      idempotencyKey: randomUUID(),
      title: "SAP is down",
      description: ERP_BLOCKER,
    });
    if (result.kind !== "created") throw new Error("ticket not created");
    await classifyTicket(db, new FakeClassifier("valid"), {
      ticketId: result.ticket.id,
      attempts: 1,
      maxAttempts: 3,
    });
    // classifyTicket ran outside the queue; its job is no longer needed.
    await db
      .update(jobs)
      .set({ status: "done" })
      .where(
        and(eq(jobs.ticketId, result.ticket.id), eq(jobs.kind, "classify")),
      );
    return result.ticket;
  }

  // Runs the Ticket's next dispatch job through the real worker loop.
  const runDispatch = (ticketId: string, webhookUrl: string) =>
    runNextJob({
      sql,
      workerId: `test-${randomUUID()}`,
      handlers: {
        dispatch: (job) => dispatchTicket(db, dispatchConfig(webhookUrl), job),
      },
      backoffMs: () => 0,
      ticketIds: [ticketId],
    });

  // Runs the Ticket's next reconcile job through the real worker loop.
  const runReconcile = (ticketId: string, notifierUrl: string) =>
    runNextJob({
      sql,
      workerId: `test-${randomUUID()}`,
      handlers: {
        reconcile: (job) => reconcileDispatch(db, { notifierUrl }, job),
      },
      backoffMs: () => 0,
      ticketIds: [ticketId],
    });

  async function snapshot(ticketId: string) {
    const [dispatch] = await db
      .select()
      .from(dispatches)
      .where(eq(dispatches.ticketId, ticketId));
    const [ticket] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.id, ticketId));
    return {
      ticket: ticket!,
      dispatch: dispatch!,
      attempts: await db
        .select()
        .from(dispatchAttempts)
        .where(eq(dispatchAttempts.dispatchId, dispatch!.id))
        .orderBy(asc(dispatchAttempts.attemptNo)),
      jobs: await db
        .select()
        .from(jobs)
        .where(eq(jobs.dispatchId, dispatch!.id)),
      events: await db
        .select()
        .from(ticketEvents)
        .where(eq(ticketEvents.ticketId, ticketId))
        .orderBy(asc(ticketEvents.id)),
    };
  }

  return { classifiedTicket, runDispatch, runReconcile, snapshot };
}
