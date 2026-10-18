import { eq } from "drizzle-orm";
import {
  canCloseOrReopen,
  canRunManualActions,
  type PolicyTicket,
  type PolicyUser,
} from "@/domain/permissions";
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
      : await ticketOfDispatch(db, target.dispatchId);
  if (!ticketId) return "not_found";
  return authorizeOnTicket(db, userId, ticketId, canRunManualActions);
}

// The Ticket a Dispatch belongs to, or undefined for an unknown Dispatch.
export async function ticketOfDispatch(
  db: Db,
  dispatchId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ ticketId: dispatches.ticketId })
    .from(dispatches)
    .where(eq(dispatches.id, dispatchId));
  return row?.ticketId;
}

// Gate for the Requester's close/reopen: only the Ticket's own Requester.
export function authorizeRequesterResponse(
  db: Db,
  userId: string,
  ticketId: string,
): Promise<ManualActionAuthorization> {
  return authorizeOnTicket(db, userId, ticketId, canCloseOrReopen);
}

async function authorizeOnTicket(
  db: Db,
  userId: string,
  ticketId: string,
  policy: (user: PolicyUser, ticket: PolicyTicket) => boolean,
): Promise<ManualActionAuthorization> {
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
  return policy(user, ticket) ? "allowed" : "forbidden";
}
