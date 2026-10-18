import { manualTicketAction } from "@/infra/api/manualAction";
import { rerunClassification } from "@/services/rerunClassification";

export const dynamic = "force-dynamic";

// Re-run AI classification: IMPLEMENTATION.md §4.7.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return manualTicketAction(
    request,
    params,
    (db, ticketId, _body, actor) => rerunClassification(db, ticketId, actor),
    { withBody: false, successStatus: 202 },
  );
}
