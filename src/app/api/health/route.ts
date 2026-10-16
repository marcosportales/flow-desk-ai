import { getSql } from "@/infra/db/client";
import { checkHealth } from "@/services/checkHealth";

export const dynamic = "force-dynamic";

export async function GET() {
  const health = await checkHealth(getSql);
  return Response.json(health, { status: health.status === "ok" ? 200 : 503 });
}
