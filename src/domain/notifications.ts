import { type PolicyTicket, ticketTeam } from "./permissions";
import type { Team } from "./routing";
import type { ClassificationState } from "./transitions";

// What a Notification tells its User about a Ticket (GLOSSARY: Notification).
export const notificationKinds = [
  // To the Assignee: the Ticket was taken by or reassigned to someone else on
  // their behalf.
  "assigned_to_you",
  // To the Requester: someone is now accountable for their Ticket.
  "ticket_assigned",
  // To each Operator of the Team whose queue the Ticket entered.
  "entered_team_queue",
  // To the Requester.
  "ticket_resolved",
  "ticket_closed",
] as const;
export type NotificationKind = (typeof notificationKinds)[number];

// The Team whose queue a Ticket is in, or null while it waits for the AI: a
// new Ticket enters a queue when classification first settles it (into a
// Team, or into Manual Review at service_desk), and again whenever its Team
// changes.
export function queueOf(
  ticket: PolicyTicket & { classificationState: ClassificationState },
): Team | null {
  if (ticket.classificationState === "pending" && !ticket.team) return null;
  return ticketTeam(ticket);
}
