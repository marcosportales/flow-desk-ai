import { manualTicketAction } from "@/infra/api/manualAction";
import { rerunClassification } from "@/services/rerunClassification";

export const dynamic = "force-dynamic";

// Re-run AI classification: IMPLEMENTATION.md §4.7.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return manualTicketAction(request, params, rerunClassification, {
    withBody: false,
    successStatus: 202,
  });
}
