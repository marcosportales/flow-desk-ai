import { retry } from "@/infra/manualActions/catalog";
import { manualActionRoute } from "@/infra/manualActions/route";

export const dynamic = "force-dynamic";

// Manual retry of a failed Dispatch: IMPLEMENTATION.md §4.7.
export const POST = manualActionRoute(retry, {
  withBody: false,
  successStatus: 202,
  successBody: (dispatchId) => ({ dispatchId, status: "pending" }),
});
