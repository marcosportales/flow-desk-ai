import { z } from "zod";
import { errorResponse } from "@/infra/api/errors";
import { rejectUnlessOperator } from "@/infra/api/manualAction";
import { getDb } from "@/infra/db/client";
import { retryDispatch } from "@/services/retryDispatch";

export const dynamic = "force-dynamic";

// Manual retry of a failed Dispatch: IMPLEMENTATION.md §4.7.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) {
    return errorResponse(404, "not_found", "Unknown dispatch");
  }
  const db = getDb();
  const rejected = await rejectUnlessOperator(request, db, { dispatchId: id });
  if (rejected) return rejected;
  const result = await retryDispatch(db, id);
  switch (result.kind) {
    case "queued":
      return Response.json(
        { dispatchId: id, status: "pending" },
        { status: 202 },
      );
    case "not_found":
      return errorResponse(404, "not_found", "Unknown dispatch");
    case "not_retryable":
      return errorResponse(
        409,
        "not_retryable",
        `Only a failed Dispatch can be retried; this one is ${result.status}`,
      );
  }
}
