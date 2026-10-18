import { manualTicketAction } from "@/infra/api/manualAction";
import { reassignTicket } from "@/services/assignTicket";

export const dynamic = "force-dynamic";

// Reassign a Ticket to another member of its Team: ADR 0008.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return manualTicketAction(request, params, reassignTicket);
}
