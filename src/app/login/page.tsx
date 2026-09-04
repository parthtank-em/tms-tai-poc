import { redirect } from "next/navigation";

import { LoginForm } from "./login-form";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getSession } from "@/lib/auth/guard";

export const metadata = {
  title: "Sign in · FreightID",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  // Already signed in — no reason to show the form again.
  if (await getSession()) {
    redirect("/shipments");
  }

  const { from } = await searchParams;
  const returnTo = from?.startsWith("/") && !from.startsWith("//") ? from : "/shipments";

  return (
    <main className="flex min-h-svh items-center justify-center px-6 py-12">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>FreightID operations console.</CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm returnTo={returnTo} />
        </CardContent>
      </Card>
    </main>
  );
}
