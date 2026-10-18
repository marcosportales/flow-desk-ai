import { manualTicketAction } from "@/infra/api/manualAction";
import { releaseTicket } from "@/services/assignTicket";

export const dynamic = "force-dynamic";

// Release a Ticket back to the Team's queue: ADR 0008.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return manualTicketAction(
    request,
    params,
    (db, ticketId, _body, actor) => releaseTicket(db, ticketId, actor),
    { withBody: false },
  );
}
