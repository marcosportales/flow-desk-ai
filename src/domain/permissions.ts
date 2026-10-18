import type { Category } from "./classification";
import { type Team, teamFor } from "./routing";

// Requester and Operator are capacities a User holds on one Ticket, not roles
// (ADR 0007). Permission comes from Team membership; assignment does not
// grant it (ADR 0008).

export type PolicyUser = { id: string; teams: readonly Team[] };

export type PolicyTicket = {
  requesterId: string;
  category: Category | null;
  team: Team | null;
};

// A Ticket with no Category yet (Manual Review) belongs to service_desk.
export function ticketTeam(ticket: PolicyTicket): Team {
  if (ticket.team) return ticket.team;
  return ticket.category ? teamFor(ticket.category) : "service_desk";
}

export function isRequester(user: PolicyUser, ticket: PolicyTicket): boolean {
  return ticket.requesterId === user.id;
}

export function isOperator(user: PolicyUser, ticket: PolicyTicket): boolean {
  return user.teams.includes(ticketTeam(ticket));
}

// Re-run AI, classify manually, Priority Override, change status, Retry Dispatch.
export function canRunManualActions(
  user: PolicyUser,
  ticket: PolicyTicket,
): boolean {
  return isOperator(user, ticket);
}

// The one control a Requester-only User gets: close ("fixed") or reopen
// ("still broken") their own Ticket. Operators get no say unless they are
// also the Ticket's Requester.
export function canCloseOrReopen(
  user: PolicyUser,
  ticket: PolicyTicket,
): boolean {
  return isRequester(user, ticket);
}
