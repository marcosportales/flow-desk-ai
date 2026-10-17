"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Spinner } from "@/components/ui/spinner";

// Re-renders the server component on an interval while work is in flight.
export function AutoRefresh({ everyMs }: { everyMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(timer);
  }, [router, everyMs]);
  return (
    <span
      role="status"
      className="flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <Spinner />
      Refreshing every {everyMs / 1000}s…
    </span>
  );
}
