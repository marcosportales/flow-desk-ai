import { classify } from "@/infra/manualActions/catalog";
import { manualActionRoute } from "@/infra/manualActions/route";

export const dynamic = "force-dynamic";

// Manual classification: IMPLEMENTATION.md §4.7.
export const POST = manualActionRoute(classify);
