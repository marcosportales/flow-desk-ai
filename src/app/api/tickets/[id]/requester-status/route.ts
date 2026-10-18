import {
  rejectUnlessRequester,
  manualTicketAction,
} from "@/infra/api/manualAction";
import { respondToResolution } from "@/services/respondToResolution";

export const dynamic = "force-dynamic";

// The Requester closes or reopens their own Ticket (SCRUM-33).
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return manualTicketAction(request, params, respondToResolution, {
    gate: rejectUnlessRequester,
  });
}
