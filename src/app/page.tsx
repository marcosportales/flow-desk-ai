import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl p-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">FlowDesk AI</CardTitle>
          <CardDescription>
            IT service desk with AI Classification and n8n Dispatch.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button nativeButton={false} render={<Link href="/tickets" />}>
            View Tickets
          </Button>
          <Button
            variant="outline"
            nativeButton={false}
            render={<Link href="/tickets/new" />}
          >
            New Request
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
