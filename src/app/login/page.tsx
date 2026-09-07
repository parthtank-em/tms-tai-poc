import { redirect } from "next/navigation";

import { LoginForm } from "./login-form";

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
    // No card. One credential, two fields — a bordered box around it only adds
    // an edge to look at.
    <main className="grid min-h-svh place-items-center px-6 py-12">
      <div className="w-full max-w-[19rem]">
        <header className="mb-8">
          <h1 className="text-lg font-semibold tracking-tight">FreightID</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Sign in to the operations console.
          </p>
        </header>

        <LoginForm returnTo={returnTo} />
      </div>
    </main>
  );
}
