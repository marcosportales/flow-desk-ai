import { take } from "@/infra/manualActions/catalog";
import { manualActionRoute } from "@/infra/manualActions/route";

export const dynamic = "force-dynamic";

// Take a Ticket that has no Assignee: ADR 0008.
export const POST = manualActionRoute(take, { withBody: false });
