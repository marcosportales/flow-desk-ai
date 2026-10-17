import { randomUUID } from "node:crypto";
import { asc } from "drizzle-orm";
import { getDb } from "@/infra/db/client";
import { requesters } from "@/infra/db/schema";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
    <main className="mx-auto max-w-2xl p-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">
            <h1>New Request</h1>
          </CardTitle>
          <CardDescription>
            Describe the problem. It is classified and routed automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RequestForm requesters={rows} idempotencyKey={randomUUID()} />
        </CardContent>
      </Card>
    </main>
  );
}
