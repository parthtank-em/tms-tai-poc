"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "cn";

/**
 * The second bar under the console header, for moving between the two halves of
 * the TAI POC.
 *
 * It replaces the cross-link buttons the two pages used to carry in their own
 * titles. A button sitting beside a page title reads as an action on that page;
 * these are navigation, and they belong somewhere that says so — the same place
 * on every page, in the chrome rather than the content.
 */
const LINKS = [
  { href: "/tai/shipments", label: "Shipments" },
  { href: "/tai/staff", label: "Staff" },
] as const;

export function TaiNav() {
  const pathname = usePathname();

  return (
    // Sits directly beneath the sticky console header, so it scrolls away while
    // that one stays. Muted ground separates the two bars without a second rule.
    <div className="border-b bg-muted/40">
      <nav className="mx-auto flex w-full max-w-7xl items-center gap-1 px-6">
        {LINKS.map((link) => {
          // A detail page (`/tai/shipments/<id>`) keeps its section marked, so
          // the prefix rather than an exact match.
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`);

          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex h-11 items-center border-b-2 px-3 text-sm transition-colors",
                active
                  ? "border-foreground font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
              )}
            >
              {link.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
