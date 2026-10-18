import { changeStatus } from "@/infra/manualActions/catalog";
import { manualActionRoute } from "@/infra/manualActions/route";

export const dynamic = "force-dynamic";

// Ticket Status change: IMPLEMENTATION.md §4.7.
export const POST = manualActionRoute(changeStatus);
