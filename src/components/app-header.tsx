import Link from "next/link";

import { logoutAction } from "@/app/login/actions";
import { Button } from "@/components/ui/button";

/**
 * The console chrome: brand link home, signed-in user, sign out.
 *
 * Shared by every authenticated segment so a page reached by URL alone still
 * looks like part of the console. Segments own their own session check — this
 * only renders what the check already returned.
 */
export function AppHeader({ username }: { username: string }) {
  return (
    <header className="border-b">
      <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-6 py-3">
        <Link href="/shipments" className="text-sm font-semibold tracking-tight">
          FreightID
        </Link>

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
