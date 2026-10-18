import { reassign } from "@/infra/manualActions/catalog";
import { manualActionRoute } from "@/infra/manualActions/route";

export const dynamic = "force-dynamic";

// Reassign a Ticket to another member of its Team: ADR 0008.
export const POST = manualActionRoute(reassign);
