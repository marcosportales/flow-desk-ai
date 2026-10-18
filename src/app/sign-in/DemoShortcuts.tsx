"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertCircleIcon } from "lucide-react";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

type Props = {
  users: { email: string; name: string; teams: string[] }[];
};

export function DemoShortcuts({ users }: Props) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function signInAs(email: string) {
    setPending(email);
    setFailed(false);
    const response = await fetch("/api/demo-sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    if (response.ok) {
      router.replace("/tickets");
      router.refresh();
    } else {
      setFailed(true);
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      {failed && (
        <Alert variant="destructive" role="alert">
          <AlertCircleIcon />
          <AlertTitle>Demo sign-in is not available.</AlertTitle>
        </Alert>
      )}
      {users.map((user) => (
        <Button
          key={user.email}
          variant="outline"
          disabled={pending !== null}
          onClick={() => signInAs(user.email)}
          className="justify-between"
        >
          <span>Sign in as {user.name}</span>
          <span className="text-muted-foreground">
            {user.teams.length ? user.teams.join(", ") : "no Team"}
          </span>
        </Button>
      ))}
    </div>
  );
}
