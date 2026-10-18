import { asc, like } from "drizzle-orm";
import type { Team } from "@/domain/routing";
import { teamMemberships, users } from "@/infra/db/schema";
import type { Db } from "./createTicket";

export type DemoUser = { email: string; name: string; teams: Team[] };

// The seeded Users offered as sign-in shortcuts: those on the demo email
// domain, by name, with their Teams.
export async function listDemoUsers(
  db: Db,
  emailDomain: string,
): Promise<DemoUser[]> {
  const rows = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(like(users.email, `%${emailDomain}`))
    .orderBy(asc(users.name));
  const memberships = await db.select().from(teamMemberships);
  return rows.map(({ id, email, name }) => ({
    email,
    name,
    teams: memberships.filter((m) => m.userId === id).map((m) => m.team),
  }));
}
