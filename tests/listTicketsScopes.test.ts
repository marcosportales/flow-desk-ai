import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Team } from "@/domain/routing";
import { tickets, users } from "@/infra/db/schema";
import { listTickets } from "@/services/listTickets";
import { connectTestDb } from "./support/db";

const { sql, db } = connectTestDb();
afterAll(() => sql.end());

const marker = `sc${randomUUID().slice(0, 8)}`;
let me: string;

const classified = {
  classificationState: "classified",
  classificationSource: "ai",
  summary: "s",
  blocksWork: false,
  impactScope: "individual",
  priority: "normal",
  computedPriority: "normal",
} as const;

async function insertUser(name: string) {
  const [row] = await db
    .insert(users)
    .values({
      name,
      email: `${randomUUID()}@test.example`,
      department: "QA",
    })
    .returning();
  return row!.id;
}

async function add(
  name: string,
  requesterId: string,
  values: Partial<typeof tickets.$inferInsert> = {},
) {
  await db.insert(tickets).values({
    requesterId,
    title: `${marker} ${name}`,
    description: "A description that is long enough.",
    idempotencyKey: randomUUID(),
    requestHash: randomUUID(),
    ...values,
  });
}

beforeAll(async () => {
  me = await insertUser("Me");
  const other = await insertUser("Other");
  await add("mine-erp", me, {
    ...classified,
    category: "erp",
    team: "it_systems",
  });
  await add("theirs-erp", other, {
    ...classified,
    category: "erp",
    team: "it_systems",
  });
  await add("theirs-data", other, {
    ...classified,
    category: "data",
    team: "data_team",
  });
  await add("theirs-review", other, { classificationState: "needs_review" });
});

async function titles(scope: string, teams: Team[]) {
  const result = await listTickets(db, { q: marker, scope }, { id: me, teams });
  if (result.kind !== "ok") throw new Error("expected a valid query");
  expect(result.total).toBe(result.tickets.length);
  return result.tickets.map((t) => t.title.replace(`${marker} `, "")).sort();
}

describe("listTickets scopes", () => {
  it("'mine' lists only the Tickets the User raised", async () => {
    expect(await titles("mine", [])).toEqual(["mine-erp"]);
  });

  it("'team' lists the Tickets of the User's Team", async () => {
    expect(await titles("team", ["it_systems"])).toEqual([
      "mine-erp",
      "theirs-erp",
    ]);
  });

  it("'team' covers both queues of a User in two Teams", async () => {
    expect(await titles("team", ["it_systems", "data_team"])).toEqual([
      "mine-erp",
      "theirs-data",
      "theirs-erp",
    ]);
  });

  it("'team' includes Tickets with no Team only for service_desk", async () => {
    expect(await titles("team", ["service_desk"])).toEqual(["theirs-review"]);
    expect(await titles("team", ["data_team"])).toEqual(["theirs-data"]);
  });

  it("'team' is empty for a User in no Team", async () => {
    expect(await titles("team", [])).toEqual([]);
  });

  it("ignores the scope when there is no viewer (API key access)", async () => {
    const result = await listTickets(db, { q: marker, scope: "mine" });
    expect(result.kind === "ok" && result.total).toBe(4);
  });
});
