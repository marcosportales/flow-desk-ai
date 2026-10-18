import { randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import * as schema from "@/infra/db/schema";
import { jobs, users, ticketEvents, tickets } from "@/infra/db/schema";
import { integrationActor, userActor } from "@/domain/actor";
import { createTicket } from "@/services/createTicket";
import { connectTestDb } from "./support/db";
import { testDatabaseUrl } from "./support/testDatabaseUrl";

const { sql, db } = connectTestDb();
afterAll(() => sql.end());

async function newRequester() {
  const [requester] = await db
    .insert(users)
    .values({
      name: "Test Person",
      email: `${randomUUID()}@test.example`,
      department: "QA",
    })
    .returning();
  return requester!;
}

const request = {
  title: "Cannot log in",
  description: "The ERP rejects my password since this morning.",
};

describe("createTicket", () => {
  it("creates the Ticket, its ticket_created event and a classify job together", async () => {
    const requester = await newRequester();
    const result = await createTicket(
      db,
      {
        requesterId: requester.id,
        idempotencyKey: randomUUID(),
        ...request,
      },
      userActor(requester.id),
    );

    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;
    expect(result.ticket).toMatchObject({
      requesterId: requester.id,
      ...request,
      status: "open",
      classificationState: "pending",
    });

    const events = await db
      .select()
      .from(ticketEvents)
      .where(eq(ticketEvents.ticketId, result.ticket.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "ticket_created",
      actor: "user",
      actorUserId: requester.id,
    });

    const queued = await db
      .select()
      .from(jobs)
      .where(eq(jobs.ticketId, result.ticket.id));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "classify", status: "queued" });
  });

  it("records the Integration as the actor of an API-submitted Request", async () => {
    const requester = await newRequester();
    const result = await createTicket(
      db,
      { requesterId: requester.id, idempotencyKey: randomUUID(), ...request },
      integrationActor,
    );
    if (result.kind !== "created") throw new Error("expected created");
    const [event] = await db
      .select()
      .from(ticketEvents)
      .where(eq(ticketEvents.ticketId, result.ticket.id));
    expect(event).toMatchObject({ actor: "integration", actorUserId: null });
  });

  it("returns the same Ticket for a Duplicate Submission", async () => {
    const requester = await newRequester();
    const input = {
      requesterId: requester.id,
      idempotencyKey: randomUUID(),
      ...request,
    };
    const first = await createTicket(db, input, integrationActor);
    const second = await createTicket(db, input, integrationActor);

    expect(first.kind).toBe("created");
    expect(second.kind).toBe("replayed");
    if (first.kind !== "created" || second.kind !== "replayed") return;
    expect(second.ticket.id).toBe(first.ticket.id);

    const [tally] = await db
      .select({ n: count() })
      .from(tickets)
      .where(eq(tickets.requesterId, requester.id));
    expect(tally!.n).toBe(1);
    const [jobTally] = await db
      .select({ n: count() })
      .from(jobs)
      .where(eq(jobs.ticketId, second.ticket.id));
    expect(jobTally!.n).toBe(1);
  });

  it("yields one Ticket when the same submission arrives concurrently", async () => {
    const requester = await newRequester();
    const input = {
      requesterId: requester.id,
      idempotencyKey: randomUUID(),
      ...request,
    };
    // The shared test connection serializes queries; a pool makes them race.
    const pool = postgres(testDatabaseUrl, { max: 5, onnotice: () => {} });
    try {
      const poolDb = drizzle(pool, { schema });
      const results = await Promise.all([
        createTicket(poolDb, input, integrationActor),
        createTicket(poolDb, input, integrationActor),
        createTicket(poolDb, input, integrationActor),
      ]);

      expect(results.filter((r) => r.kind === "created")).toHaveLength(1);
      expect(results.filter((r) => r.kind === "replayed")).toHaveLength(2);
    } finally {
      await pool.end();
    }
  });

  it("reports a conflict when the key is reused with a different body", async () => {
    const requester = await newRequester();
    const idempotencyKey = randomUUID();
    await createTicket(
      db,
      {
        requesterId: requester.id,
        idempotencyKey,
        ...request,
      },
      integrationActor,
    );
    const result = await createTicket(
      db,
      {
        requesterId: requester.id,
        idempotencyKey,
        ...request,
        title: "A different request",
      },
      integrationActor,
    );

    expect(result.kind).toBe("conflict");
  });

  it("scopes the key to the Requester", async () => {
    const a = await newRequester();
    const b = await newRequester();
    const idempotencyKey = randomUUID();
    const first = await createTicket(
      db,
      {
        requesterId: a.id,
        idempotencyKey,
        ...request,
      },
      integrationActor,
    );
    const second = await createTicket(
      db,
      {
        requesterId: b.id,
        idempotencyKey,
        ...request,
      },
      integrationActor,
    );

    expect(first.kind).toBe("created");
    expect(second.kind).toBe("created");
  });

  it.each([
    ["short title", { title: "ab" }],
    ["long title", { title: "x".repeat(201) }],
    ["short description", { description: "too short" }],
    ["long description", { description: "x".repeat(5001) }],
    ["bad requester id", { requesterId: "nope" }],
    ["empty key", { idempotencyKey: "" }],
  ])("rejects invalid input: %s", async (_name, override) => {
    const requester = await newRequester();
    const result = await createTicket(
      db,
      {
        requesterId: requester.id,
        idempotencyKey: randomUUID(),
        ...request,
        ...override,
      },
      integrationActor,
    );

    expect(result.kind).toBe("invalid");
  });

  it("reports an unknown Requester as invalid", async () => {
    const result = await createTicket(
      db,
      {
        requesterId: randomUUID(),
        idempotencyKey: randomUUID(),
        ...request,
      },
      integrationActor,
    );

    expect(result.kind).toBe("invalid");
  });
});
