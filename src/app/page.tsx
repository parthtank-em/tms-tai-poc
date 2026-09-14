import { ArrowRightIcon } from "lucide-react";
import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireSession } from "@/lib/auth/guard";
import { pocs } from "@/lib/pocs";

export const metadata = {
  title: "POCs · FreightID",
  description: "Proof-of-concept integrations built on the FreightID console.",
};

export default async function Home() {
  // `/` is gated like every other console route, and the check lives here
  // rather than in the proxy alone — see src/lib/auth/guard.ts.
  const session = await requireSession("/");

  return (
    <div className="min-h-svh">
      <AppHeader username={session.username} />

      <main className="mx-auto w-full max-w-7xl px-6 py-16">
        <header className="mb-10">
          <h1 className="text-3xl font-semibold tracking-tight">POCs</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Pick an integration to open its console.
          </p>
        </header>

        <div className="grid gap-6 sm:grid-cols-2">
          {pocs.map((poc) => (
            // The link wraps the card so the whole surface is the hit target,
            // not just the title.
            <Link key={poc.href} href={poc.href} className="group rounded-xl">
              <Card className="h-full transition-colors group-hover:bg-muted/50 group-focus-visible:ring-2 group-focus-visible:ring-ring">
                <CardHeader>
                  <CardTitle className="text-2xl leading-tight font-semibold tracking-tight sm:text-3xl">
                    {poc.title}
                  </CardTitle>
                  <CardDescription className="mt-2">{poc.description}</CardDescription>
                </CardHeader>

                <div className="mt-auto flex items-center gap-1.5 px-(--card-spacing) text-sm font-medium text-muted-foreground">
                  Open
                  <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" />
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
