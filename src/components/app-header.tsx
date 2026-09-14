import Link from "next/link";

import { PocNav } from "@/components/poc-nav";
import { Button } from "@/components/ui/button";
import { logoutAction } from "@/app/login/actions";

/**
 * The console chrome: brand link home, navigation, signed-in user, sign out.
 *
 * Shared by every authenticated segment so a page reached by URL alone still
 * looks like part of the console. Segments own their own session check — this
 * only renders what the check already returned.
 */
export function AppHeader({ username }: { username: string }) {
  return (
    // Sticky rather than fixed: it pins to the top on scroll without leaving
    // the flow, so no page has to reserve a gap for it. The background is
    // opaque because content scrolls underneath.
    <header className="sticky top-0 z-50 border-b bg-background">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-6 py-3">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-sm font-semibold tracking-tight">
            FreightID
          </Link>

          <nav className="flex items-center gap-1">
            {/*
              Same destination as the brand link, spelled out. A wordmark is not
              an obvious control, so the way back to the POC index gets a label.
            */}
            <Link
              href="/"
              className="inline-flex h-9 items-center rounded-lg px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Dashboard
            </Link>

            <PocNav />
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">{username}</span>
          <form action={logoutAction}>
            <Button type="submit" variant="outline" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
