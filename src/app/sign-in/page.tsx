import { redirect } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { demoEmailDomain, demoSignInEnabled } from "@/infra/auth/demo";
import { getCurrentUser } from "@/infra/auth/session";
import { getDb } from "@/infra/db/client";
import { listDemoUsers } from "@/services/listDemoUsers";
import { DemoShortcuts } from "./DemoShortcuts";
import { SignInForm } from "./SignInForm";

export const dynamic = "force-dynamic";

export default async function SignInPage() {
  if (await getCurrentUser()) redirect("/tickets");
  const shortcuts = demoSignInEnabled()
    ? await listDemoUsers(getDb(), demoEmailDomain)
    : [];

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 p-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">
            <h1>Sign in</h1>
          </CardTitle>
          <CardDescription>Use your FlowDesk AI account.</CardDescription>
        </CardHeader>
        <CardContent>
          <SignInForm />
        </CardContent>
      </Card>
      {shortcuts.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              <h2>Demo Users</h2>
            </CardTitle>
            <CardDescription>
              Shortcuts for the seeded fictional Users.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Separator className="mb-4" />
            <DemoShortcuts users={shortcuts} />
          </CardContent>
        </Card>
      )}
    </main>
  );
}
