import { randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { submitRequest } from "@/app/tickets/new/actions";
import { requesters, tickets } from "@/infra/db/schema";
import { connectTestDb } from "./support/db";
import { testDatabaseUrl } from "./support/testDatabaseUrl";

const { sql, db } = connectTestDb();

beforeAll(() => {
  process.env.DATABASE_URL = testDatabaseUrl;
});
afterAll(() => sql.end());

async function newRequester() {
  const [requester] = await db
    .insert(requesters)
    .values({
      name: "Form Person",
      email: `${randomUUID()}@test.example`,
      department: "QA",
    })
    .returning();
  return requester!;
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

describe("submitRequest (/tickets/new)", () => {
  it("creates one Ticket when the same form render is submitted twice", async () => {
    const requester = await newRequester();
    const fields = {
      requesterId: requester.id,
      title: "Printer is on fire",
      description: "The third floor printer is smoking again.",
      idempotencyKey: randomUUID(),
    };

    const first = await submitRequest({ status: "idle" }, form(fields));
    const second = await submitRequest({ status: "idle" }, form(fields));

    expect(first.status).toBe("created");
    expect(second.status).toBe("created");
    if (first.status !== "created" || second.status !== "created") return;
    expect(second.ticketNumber).toBe(first.ticketNumber);

    const [tally] = await db
      .select({ n: count() })
      .from(tickets)
      .where(eq(tickets.requesterId, requester.id));
    expect(tally!.n).toBe(1);
  });

  it("returns field errors for invalid input", async () => {
    const requester = await newRequester();
    const result = await submitRequest(
      { status: "idle" },
      form({
        requesterId: requester.id,
        title: "ab",
        description: "short",
        idempotencyKey: randomUUID(),
      }),
    );

    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.fieldErrors).toHaveProperty("title");
    expect(result.fieldErrors).toHaveProperty("description");
  });
});
