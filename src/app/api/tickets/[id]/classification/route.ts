import { manualTicketAction } from "@/infra/api/manualAction";
import { classifyManually } from "@/services/classifyManually";

export const dynamic = "force-dynamic";

// Manual classification: IMPLEMENTATION.md §4.7.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return manualTicketAction(request, params, classifyManually);
}
