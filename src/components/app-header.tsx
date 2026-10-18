import Link from "next/link";
import { PlusIcon } from "lucide-react";
import { signOut } from "@/app/sign-in/actions";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/infra/auth/session";

export async function AppHeader() {
  const user = await getCurrentUser();

  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
        <nav aria-label="Main" className="flex items-center gap-1">
          <Link href="/" className="mr-3 font-heading text-base font-semibold">
            FlowDesk AI
          </Link>
          {user && (
            <Button
              variant="ghost"
              nativeButton={false}
              render={<Link href="/tickets" />}
            >
              Tickets
            </Button>
          )}
        </nav>
        {user && (
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">{user.name}</span>
            <form action={signOut}>
              <Button type="submit" variant="outline">
                Sign out
              </Button>
            </form>
            <Button nativeButton={false} render={<Link href="/tickets/new" />}>
              <PlusIcon data-icon="inline-start" />
              New Request
            </Button>
          </div>
        )}
      </div>
    </header>
  );
}
