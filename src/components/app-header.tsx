import Link from "next/link";
import { PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

export function AppHeader() {
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
        <nav aria-label="Main" className="flex items-center gap-1">
          <Link href="/" className="mr-3 font-heading text-base font-semibold">
            FlowDesk AI
          </Link>
          <Button
            variant="ghost"
            nativeButton={false}
            render={<Link href="/tickets" />}
          >
            Tickets
          </Button>
        </nav>
        <Button nativeButton={false} render={<Link href="/tickets/new" />}>
          <PlusIcon data-icon="inline-start" />
          New Request
        </Button>
      </div>
    </header>
  );
}
