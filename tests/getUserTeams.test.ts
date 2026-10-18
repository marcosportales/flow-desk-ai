import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { teamMemberships, users } from "@/infra/db/schema";
import { getUserTeams } from "@/services/getUserTeams";
import { connectTestDb } from "./support/db";

const { sql, db } = connectTestDb();
afterAll(() => sql.end());

async function insertUser() {
  const [row] = await db
    .insert(users)
    .values({
      name: "Team Person",
      email: `${randomUUID()}@test.example`,
      department: "QA",
    })
    .returning();
  return row!.id;
}

describe("getUserTeams", () => {
  it("is empty for a User in no Team", async () => {
    expect(await getUserTeams(db, await insertUser())).toEqual([]);
  });

  it("returns every Team of a User in two Teams, and only theirs", async () => {
    const id = await insertUser();
    const otherId = await insertUser();
    await db.insert(teamMemberships).values([
      { userId: id, team: "it_systems" },
      { userId: id, team: "data_team" },
      { userId: otherId, team: "service_desk" },
    ]);
    expect((await getUserTeams(db, id)).sort()).toEqual([
      "data_team",
      "it_systems",
    ]);
  });
});
