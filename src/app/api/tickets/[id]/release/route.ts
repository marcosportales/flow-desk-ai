import { release } from "@/infra/manualActions/catalog";
import { manualActionRoute } from "@/infra/manualActions/route";

export const dynamic = "force-dynamic";

// Release a Ticket back to the Team's queue: ADR 0008.
export const POST = manualActionRoute(release, { withBody: false });
