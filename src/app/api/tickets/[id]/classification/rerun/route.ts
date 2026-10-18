import { rerun } from "@/infra/manualActions/catalog";
import { manualActionRoute } from "@/infra/manualActions/route";

export const dynamic = "force-dynamic";

// Re-run AI classification: IMPLEMENTATION.md §4.7.
export const POST = manualActionRoute(rerun, {
  withBody: false,
  successStatus: 202,
});
