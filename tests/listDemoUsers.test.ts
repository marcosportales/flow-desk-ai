import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { teamMemberships, users } from "@/infra/db/schema";
import { listDemoUsers } from "@/services/listDemoUsers";
import { connectTestDb } from "./support/db";

const { sql, db } = connectTestDb();
afterAll(() => sql.end());

describe("listDemoUsers", () => {
  it("lists the Users on the demo domain by name, with their Teams", async () => {
    const domain = `@${randomUUID()}.example`;
    const [zoe, adam] = await db
      .insert(users)
      .values([
        { name: "Zoe Demo", email: `zoe${domain}`, department: "QA" },
        { name: "Adam Demo", email: `adam${domain}`, department: "QA" },
        {
          name: "Other",
          email: `other@${randomUUID()}.example`,
          department: "QA",
        },
      ])
      .returning();
    await db.insert(teamMemberships).values([
      { userId: zoe!.id, team: "it_systems" },
      { userId: zoe!.id, team: "data_team" },
    ]);

    const listed = await listDemoUsers(db, domain);

    expect(listed.map((u) => u.name)).toEqual(["Adam Demo", "Zoe Demo"]);
    expect(listed[0]).toEqual({
      email: adam!.email,
      name: "Adam Demo",
      teams: [],
    });
    expect(listed[1]!.teams.sort()).toEqual(["data_team", "it_systems"]);
  });
});
