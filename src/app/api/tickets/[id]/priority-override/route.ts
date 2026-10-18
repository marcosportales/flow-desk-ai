import { overridePriorityAction } from "@/infra/manualActions/catalog";
import { manualActionRoute } from "@/infra/manualActions/route";

export const dynamic = "force-dynamic";

// Priority Override: IMPLEMENTATION.md §4.7.
export const POST = manualActionRoute(overridePriorityAction);
