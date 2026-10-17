"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Re-renders the server component on an interval while work is in flight.
export function AutoRefresh({ everyMs }: { everyMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(timer);
  }, [router, everyMs]);
  return (
    <span role="status" className="text-xs text-slate-500">
      Refreshing every {everyMs / 1000}s…
    </span>
  );
}
