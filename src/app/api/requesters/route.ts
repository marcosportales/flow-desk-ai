import { asc } from "drizzle-orm";
import { rejectUnlessAuthorized } from "@/infra/api/auth";
import { getDb } from "@/infra/db/client";
import { users } from "@/infra/db/schema";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = rejectUnlessAuthorized(request);
  if (unauthorized) return unauthorized;

  const rows = await getDb()
    .select({
      id: users.id,
      name: users.name,
      department: users.department,
    })
    .from(users)
    .orderBy(asc(users.name));
  return Response.json({ requesters: rows });
}
