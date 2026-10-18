import { randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const requireUser = vi.hoisted(() => vi.fn());
vi.mock("@/infra/auth/session", () => ({ requireUser }));

import { submitRequest } from "@/app/tickets/new/actions";
import { users, tickets } from "@/infra/db/schema";
import { connectTestDb } from "./support/db";
import { testDatabaseUrl } from "./support/testDatabaseUrl";

const { sql, db } = connectTestDb();

beforeAll(() => {
  process.env.DATABASE_URL = testDatabaseUrl;
});
afterAll(() => sql.end());

async function newRequester() {
  const [requester] = await db
    .insert(users)
    .values({
      name: "Form Person",
      email: `${randomUUID()}@test.example`,
      department: "QA",
    })
    .returning();
  requireUser.mockResolvedValue(requester!);
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
    expect(first.ticketId).toBeTruthy();
    expect(second.ticketId).toBe(first.ticketId);

    const [tally] = await db
      .select({ n: count() })
      .from(tickets)
      .where(eq(tickets.requesterId, requester.id));
    expect(tally!.n).toBe(1);
  });

  it("submits as the signed-in User and ignores any requesterId field", async () => {
    const requester = await newRequester();
    const other = await newRequester();
    requireUser.mockResolvedValue(requester);

    const result = await submitRequest(
      { status: "idle" },
      form({
        requesterId: other.id,
        title: "Badge reader broken",
        description: "The lobby badge reader rejects every badge.",
        idempotencyKey: randomUUID(),
      }),
    );

    expect(result.status).toBe("created");
    const [ticket] = await db
      .select()
      .from(tickets)
      .where(eq(tickets.requesterId, requester.id));
    expect(ticket).toBeDefined();
  });

  it("returns field errors for invalid input", async () => {
    await newRequester();
    const result = await submitRequest(
      { status: "idle" },
      form({
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
