import { randomUUID } from "node:crypto";
import { requireUser } from "@/infra/auth/session";
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
  await requireUser();
  const idempotencyKey = randomUUID();
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
          {/* Keyed by the idempotency key so a refresh remounts the form with
              fresh state and a fresh key. */}
          <RequestForm key={idempotencyKey} idempotencyKey={idempotencyKey} />
        </CardContent>
      </Card>
    </main>
  );
}
