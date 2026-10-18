import { eq } from "drizzle-orm";
import type { Team } from "@/domain/routing";
import { teamMemberships } from "@/infra/db/schema";
import type { Db } from "./createTicket";

// The Teams a User belongs to; the input of every permission decision.
export async function getUserTeams(db: Db, userId: string): Promise<Team[]> {
  const rows = await db
    .select({ team: teamMemberships.team })
    .from(teamMemberships)
    .where(eq(teamMemberships.userId, userId));
  return rows.map((r) => r.team);
}
