import { randomUUID } from "node:crypto";
import { asc } from "drizzle-orm";
import { getDb } from "@/infra/db/client";
import { requesters } from "@/infra/db/schema";
import { RequestForm } from "./RequestForm";

// Rendered per request: the idempotency key must differ on every page load.
export const dynamic = "force-dynamic";

export default async function NewTicketPage() {
  const rows = await getDb()
    .select({
      id: requesters.id,
      name: requesters.name,
      department: requesters.department,
    })
    .from(requesters)
    .orderBy(asc(requesters.name));

  return (
    <main>
      <h1>New Request</h1>
      <RequestForm requesters={rows} idempotencyKey={randomUUID()} />
    </main>
  );
}
