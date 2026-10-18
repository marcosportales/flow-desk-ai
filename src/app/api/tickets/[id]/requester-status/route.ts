import { respond } from "@/infra/manualActions/catalog";
import { manualActionRoute } from "@/infra/manualActions/route";

export const dynamic = "force-dynamic";

// The Requester closes or reopens their own Ticket (SCRUM-33).
export const POST = manualActionRoute(respond);
