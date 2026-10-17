import { manualTicketAction } from "@/infra/api/manualAction";
import { changeTicketStatus } from "@/services/changeTicketStatus";

export const dynamic = "force-dynamic";

// Ticket Status change: IMPLEMENTATION.md §4.7.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return manualTicketAction(request, params, changeTicketStatus);
}
