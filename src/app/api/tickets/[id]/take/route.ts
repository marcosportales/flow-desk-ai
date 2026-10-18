import { manualTicketAction } from "@/infra/api/manualAction";
import { takeTicket } from "@/services/assignTicket";

export const dynamic = "force-dynamic";

// Take an unowned Ticket: ADR 0008.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return manualTicketAction(
    request,
    params,
    (db, ticketId, _body, actor) => takeTicket(db, ticketId, actor),
    { withBody: false },
  );
}
