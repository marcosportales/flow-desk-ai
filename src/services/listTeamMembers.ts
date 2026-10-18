import { asc, eq } from "drizzle-orm";
import { ticketTeam } from "@/domain/permissions";
import { teamMemberships, tickets, users } from "@/infra/db/schema";
import type { Db } from "./createTicket";

// The Users a Ticket can be reassigned to: members of its Team.
export async function listTeamMembers(
  db: Db,
  ticketId: string,
): Promise<{ id: string; name: string }[]> {
  const [ticket] = await db
    .select({
      requesterId: tickets.requesterId,
      category: tickets.category,
      team: tickets.team,
    })
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  if (!ticket) return [];

  return db
    .select({ id: users.id, name: users.name })
    .from(teamMemberships)
    .innerJoin(users, eq(users.id, teamMemberships.userId))
    .where(eq(teamMemberships.team, ticketTeam(ticket)))
    .orderBy(asc(users.name));
}
