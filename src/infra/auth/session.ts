import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "./auth";

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  department: string;
};

export const signInPath = "/sign-in";

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) return null;
  const { id, name, email, department } = session.user as CurrentUser;
  return { id, name, email, department };
}

// For pages and Server Actions: the signed-in User, or a redirect to sign-in.
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect(signInPath);
  return user;
}
