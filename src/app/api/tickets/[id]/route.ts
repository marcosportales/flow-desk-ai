import { z } from "zod";
import { rejectUnlessAuthorized } from "@/infra/api/auth";
import { errorResponse } from "@/infra/api/errors";
import { getDb } from "@/infra/db/client";
import { getTicketDetail } from "@/services/getTicketDetail";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const unauthorized = rejectUnlessAuthorized(request);
  if (unauthorized) return unauthorized;

  const { id } = await params;
  if (!z.uuid().safeParse(id).success) {
    return errorResponse(404, "not_found", "Unknown ticket");
  }
  const result = await getTicketDetail(getDb(), id);
  if (result.kind === "not_found") {
    return errorResponse(404, "not_found", "Unknown ticket");
  }
  return Response.json(result.detail);
}
