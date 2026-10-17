import { manualTicketAction } from "@/infra/api/manualAction";
import { overridePriority } from "@/services/overridePriority";

export const dynamic = "force-dynamic";

// Priority Override: IMPLEMENTATION.md §4.7.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return manualTicketAction(request, params, overridePriority);
}
