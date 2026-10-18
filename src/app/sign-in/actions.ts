"use server";

import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuth } from "@/infra/auth/auth";
import { signInPath } from "@/infra/auth/session";

export type SignInState =
  { status: "idle" } | { status: "error"; message: string };

const text = (data: FormData, name: string) => {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
};

export async function signInWithPassword(
  _previous: SignInState,
  data: FormData,
): Promise<SignInState> {
  try {
    await getAuth().api.signInEmail({
      body: { email: text(data, "email"), password: text(data, "password") },
      headers: await headers(),
    });
  } catch (error) {
    if (error instanceof APIError) {
      return { status: "error", message: "Invalid email or password." };
    }
    throw error;
  }
  redirect("/tickets");
}

export async function signOut() {
  await getAuth().api.signOut({ headers: await headers() });
  redirect(signInPath);
}
