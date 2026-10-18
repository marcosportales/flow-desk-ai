import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { teamMemberships, tickets, users } from "@/infra/db/schema";
import { getTicketDetail } from "@/services/getTicketDetail";
import { listTickets } from "@/services/listTickets";
import { connectTestDb } from "./support/db";

const { sql, db } = connectTestDb();
afterAll(() => sql.end());

const marker = `as${randomUUID().slice(0, 8)}`;
let me: string;
let colleague: string;
let mineId: string;

async function insertOperator(name: string) {
  const [row] = await db
    .insert(users)
    .values({ name, email: `${randomUUID()}@t.example`, department: "QA" })
    .returning();
  await db
    .insert(teamMemberships)
    .values({ userId: row!.id, team: "service_desk" });
  return row!.id;
}

async function add(name: string, assigneeId: string | null) {
  const [row] = await db
    .insert(tickets)
    .values({
      requesterId: me,
      title: `${marker} ${name}`,
      description: "A description that is long enough.",
      idempotencyKey: randomUUID(),
      requestHash: randomUUID(),
      assigneeId,
    })
    .returning({ id: tickets.id });
  return row!.id;
}

beforeAll(async () => {
  me = await insertOperator("Me Operator");
  colleague = await insertOperator("Colleague Operator");
  mineId = await add("mine", me);
  await add("theirs", colleague);
  await add("unowned", null);
});

const viewer = () => ({ id: me, teams: ["service_desk" as const] });
const titles = async (query: Record<string, string>) => {
  const result = await listTickets(
    db,
    { q: marker, scope: "team", ...query },
    viewer(),
  );
  if (result.kind !== "ok") throw new Error("invalid query");
  return result.tickets.map((t) => t.title.replace(`${marker} `, "")).sort();
};

describe("assignee filters", () => {
  it("lists every Ticket of the queue without a filter", async () => {
    expect(await titles({})).toEqual(["mine", "theirs", "unowned"]);
  });

  it("'unassigned' lists only unowned Tickets", async () => {
    expect(await titles({ assignee: "unassigned" })).toEqual(["unowned"]);
  });

  it("'mine' lists only Tickets assigned to the viewer", async () => {
    expect(await titles({ assignee: "mine" })).toEqual(["mine"]);
  });

  it("rejects an unknown filter value", async () => {
    const result = await listTickets(db, { assignee: "everyone" }, viewer());
    expect(result.kind).toBe("invalid");
  });

  it("shows the Assignee's name on each row", async () => {
    const result = await listTickets(
      db,
      { q: marker, scope: "team" },
      viewer(),
    );
    if (result.kind !== "ok") throw new Error("invalid query");
    const byTitle = Object.fromEntries(
      result.tickets.map((t) => [t.title, t.assigneeName]),
    );
    expect(byTitle[`${marker} theirs`]).toBe("Colleague Operator");
    expect(byTitle[`${marker} unowned`]).toBeNull();
  });
});

describe("ticket detail", () => {
  it("includes the Assignee", async () => {
    const result = await getTicketDetail(db, mineId, viewer());
    if (result.kind !== "ok") throw new Error("not found");
    expect(result.detail.assignee).toMatchObject({
      id: me,
      name: "Me Operator",
    });
  });

  it("has no Assignee for an unowned Ticket", async () => {
    const id = await add("detail-unowned", null);
    const result = await getTicketDetail(db, id, viewer());
    if (result.kind !== "ok") throw new Error("not found");
    expect(result.detail.assignee).toBeNull();
  });
});
