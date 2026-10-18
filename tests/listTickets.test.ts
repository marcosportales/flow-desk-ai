import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatches, users, tickets } from "@/infra/db/schema";
import {
  getTicketCounters,
  listTickets,
  listTicketsQuery,
} from "@/services/listTickets";
import { connectTestDb } from "./support/db";

const { sql, db } = connectTestDb();
afterAll(() => sql.end());

// Titles carry a per-run marker so assertions are not affected by other tests'
// Tickets in the shared database.
const marker = `lt${randomUUID().slice(0, 8)}`;
const byMarker = { q: marker };

let requesterId: string;
const ids: Record<string, string> = {};

async function insertTicket(
  name: string,
  values: Partial<typeof tickets.$inferInsert> = {},
) {
  const [row] = await db
    .insert(tickets)
    .values({
      requesterId,
      title: `${marker} ${name}`,
      description: "A description that is long enough.",
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
      ...values,
    })
    .returning();
  ids[name] = row!.id;
  return row!;
}

const classified = {
  classificationState: "classified",
  classificationSource: "ai",
  summary: "s",
  blocksWork: false,
  impactScope: "individual",
  team: "it_systems",
} as const;

async function insertDispatch(
  ticketId: string,
  sequence: number,
  status: (typeof dispatches.$inferInsert)["status"],
) {
  await db.insert(dispatches).values({
    ticketId,
    sequence,
    category: "erp",
    priority: "normal",
    team: "it_systems",
    route: "standard",
    status,
  });
}

beforeAll(async () => {
  const [requester] = await db
    .insert(users)
    .values({
      name: "List Person",
      email: `${randomUUID()}@test.example`,
      department: "QA",
    })
    .returning();
  requesterId = requester!.id;

  await insertTicket("pending");
  await insertTicket("erp-urgent", {
    ...classified,
    category: "erp",
    priority: "urgent",
    computedPriority: "urgent",
    externalReference: "INC-000042",
  });
  await insertTicket("access-low", {
    ...classified,
    category: "access",
    priority: "low",
    computedPriority: "low",
    team: "identity_access",
  });
  await insertTicket("review", { classificationState: "needs_review" });
  await insertTicket("resolved", { status: "resolved" });

  // Latest Dispatch wins: failed first, then a succeeded retry.
  await insertDispatch(ids["erp-urgent"]!, 1, "failed");
  await insertDispatch(ids["erp-urgent"]!, 2, "succeeded");
  await insertDispatch(ids["access-low"]!, 1, "failed");
});

async function titles(filters: Record<string, string>) {
  const result = await listTickets(db, { ...byMarker, ...filters });
  if (result.kind !== "ok") throw new Error("expected valid filters");
  return result.tickets.map((t) => t.title.replace(`${marker} `, "")).sort();
}

describe("listTickets", () => {
  it("returns every Ticket with Requester and latest Dispatch Status, newest first", async () => {
    const result = await listTickets(db, byMarker);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.total).toBe(5);
    const erp = result.tickets.find((t) => t.id === ids["erp-urgent"])!;
    expect(erp.requesterName).toBe("List Person");
    expect(erp.dispatchStatus).toBe("succeeded");
    expect(erp.externalReference).toBe("INC-000042");
    const pending = result.tickets.find((t) => t.id === ids["pending"])!;
    expect(pending.dispatchStatus).toBeNull();
    expect(pending.externalReference).toBeNull();
    expect(result.tickets[0]!.createdAt >= result.tickets[4]!.createdAt).toBe(
      true,
    );
  });

  it("filters by status", async () => {
    expect(await titles({ status: "resolved" })).toEqual(["resolved"]);
  });

  it("filters by classification_state", async () => {
    expect(await titles({ classification_state: "needs_review" })).toEqual([
      "review",
    ]);
    expect(await titles({ classification_state: "classified" })).toEqual([
      "access-low",
      "erp-urgent",
    ]);
  });

  it("filters by category", async () => {
    expect(await titles({ category: "access" })).toEqual(["access-low"]);
  });

  it("filters by priority", async () => {
    expect(await titles({ priority: "urgent" })).toEqual(["erp-urgent"]);
  });

  it("filters by the latest Dispatch Status only", async () => {
    expect(await titles({ dispatch_status: "failed" })).toEqual(["access-low"]);
    expect(await titles({ dispatch_status: "succeeded" })).toEqual([
      "erp-urgent",
    ]);
  });

  it("searches the title case-insensitively and treats wildcards literally", async () => {
    expect(await titles({ q: `${marker.toUpperCase()} ACCESS` })).toEqual([
      "access-low",
    ]);
    expect(await titles({ q: `${marker} %` })).toEqual([]);
  });

  it("combines filters", async () => {
    expect(
      await titles({ category: "erp", priority: "urgent", status: "open" }),
    ).toEqual(["erp-urgent"]);
    expect(await titles({ category: "erp", priority: "low" })).toEqual([]);
  });

  it("paginates", async () => {
    const first = await listTickets(db, { ...byMarker, page_size: "2" });
    const third = await listTickets(db, {
      ...byMarker,
      page_size: "2",
      page: "3",
    });
    if (first.kind !== "ok" || third.kind !== "ok") throw new Error("invalid");
    expect(first.tickets).toHaveLength(2);
    expect(first.total).toBe(5);
    expect(third.tickets).toHaveLength(1);
    expect(third.page).toBe(3);
  });

  it("rejects unknown filter values", async () => {
    for (const bad of [
      { status: "bogus" },
      { priority: "x" },
      { page: "0" },
      { page_size: "1000" },
    ]) {
      const result = await listTickets(db, bad);
      expect(result.kind).toBe("invalid");
    }
  });
});

describe("listTickets scoped to a Requester", () => {
  it("lists only the Tickets that User raised", async () => {
    const [other] = await db
      .insert(users)
      .values({
        name: "Other Person",
        email: `${randomUUID()}@test.example`,
        department: "QA",
      })
      .returning();
    const theirs = await insertTicket("theirs", { requesterId: other!.id });

    const mine = await listTickets(db, byMarker, {
      id: requesterId,
      teams: [],
    });
    const others = await listTickets(db, byMarker, {
      id: other!.id,
      teams: [],
    });
    if (mine.kind !== "ok" || others.kind !== "ok") throw new Error("ok");

    expect(mine.tickets.map((t) => t.id)).not.toContain(theirs.id);
    expect(mine.total).toBe(5);
    expect(others.tickets.map((t) => t.id)).toEqual([theirs.id]);
    expect(others.total).toBe(1);
  });

  it("scopes the counters too", async () => {
    const [lonely] = await db
      .insert(users)
      .values({
        name: "Lonely Person",
        email: `${randomUUID()}@test.example`,
        department: "QA",
      })
      .returning();
    expect(await getTicketCounters(db, { id: lonely!.id, teams: [] })).toEqual({
      open: 0,
      needsReview: 0,
      failedDispatches: 0,
      urgent: 0,
    });
  });
});

describe("listTicketsQuery", () => {
  it("accepts URLSearchParams-like input and ignores empty values", () => {
    const parsed = listTicketsQuery.safeParse({
      status: "",
      classification_state: "",
      category: "",
      priority: "",
      dispatch_status: "",
      q: "",
      page: "",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("getTicketCounters", () => {
  // Other test files insert Tickets concurrently, so only lower bounds hold.
  it("counts open, needs review, failed Dispatches and urgent Tickets", async () => {
    const before = await getTicketCounters(db);
    const fresh = await insertTicket("counter-urgent", {
      ...classified,
      category: "erp",
      priority: "urgent",
      computedPriority: "urgent",
    });
    await insertDispatch(fresh.id, 1, "failed");
    await insertTicket("counter-review", {
      classificationState: "needs_review",
    });
    await insertTicket("counter-resolved", {
      status: "resolved",
      ...classified,
      category: "erp",
      priority: "urgent",
      computedPriority: "urgent",
    });
    const after = await getTicketCounters(db);

    expect(after.open - before.open).toBeGreaterThanOrEqual(2);
    expect(after.needsReview - before.needsReview).toBeGreaterThanOrEqual(1);
    expect(
      after.failedDispatches - before.failedDispatches,
    ).toBeGreaterThanOrEqual(1);
    expect(after.urgent - before.urgent).toBeGreaterThanOrEqual(1);
  });
});
