"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { verifyCredentials } from "@/lib/auth/credentials";
import { createSessionToken, sessionCookie } from "@/lib/auth/session";

export type LoginState = { error: string | null };

/** Only same-origin paths, so `?from=` cannot be turned into an open redirect. */
function safeReturnTo(value: FormDataEntryValue | null): string {
  const path = typeof value === "string" ? value : "";
  return path.startsWith("/") && !path.startsWith("//") ? path : "/shipments";
}

export async function loginAction(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const username = String(formData.get("username") ?? "");
  const password = String(formData.get("password") ?? "");
  const returnTo = safeReturnTo(formData.get("from"));

  if (!username || !password) {
    return { error: "Enter both a username and a password." };
  }

  if (!verifyCredentials(username, password)) {
    // One message for both cases — saying which half was wrong would confirm
    // whether a username exists.
    return { error: "Incorrect username or password." };
  }

  const { token, maxAge } = createSessionToken(username);
  const store = await cookies();
  store.set(sessionCookie.name, token, sessionCookie.options(maxAge));

  redirect(returnTo);
}

export async function logoutAction(): Promise<void> {
  const store = await cookies();
  store.delete(sessionCookie.name);
  redirect("/login");
}
