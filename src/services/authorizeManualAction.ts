import { eq } from "drizzle-orm";
import { canRunManualActions } from "@/domain/permissions";
import { dispatches, tickets } from "@/infra/db/schema";
import type { Db } from "./createTicket";
import { getUserTeams } from "./getUserTeams";

export type ManualActionAuthorization = "allowed" | "forbidden" | "not_found";

// Server-side gate for every Manual Action (ADR 0008): the User must be an
// Operator of the Ticket's Team. A Dispatch is checked through its Ticket.
export async function authorizeManualAction(
  db: Db,
  userId: string,
  target: { ticketId: string } | { dispatchId: string },
): Promise<ManualActionAuthorization> {
  const ticketId =
    "ticketId" in target
      ? target.ticketId
      : (
          await db
            .select({ ticketId: dispatches.ticketId })
            .from(dispatches)
            .where(eq(dispatches.id, target.dispatchId))
        )[0]?.ticketId;
  if (!ticketId) return "not_found";

  const [ticket] = await db
    .select({
      requesterId: tickets.requesterId,
      category: tickets.category,
      team: tickets.team,
    })
    .from(tickets)
    .where(eq(tickets.id, ticketId));
  if (!ticket) return "not_found";

  const user = { id: userId, teams: await getUserTeams(db, userId) };
  return canRunManualActions(user, ticket) ? "allowed" : "forbidden";
}
