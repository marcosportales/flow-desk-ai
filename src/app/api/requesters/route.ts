import { rejectUnlessAuthorized } from "@/infra/api/auth";
import { getDb } from "@/infra/db/client";
import { listRequesters } from "@/services/listRequesters";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = rejectUnlessAuthorized(request);
  if (unauthorized) return unauthorized;

  return Response.json({ requesters: await listRequesters(getDb()) });
}
