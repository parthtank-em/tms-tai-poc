"use client";

import Link from "next/link";

import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
} from "@/components/ui/navigation-menu";
import { pocs } from "@/lib/pocs";

/**
 * The "POCs" menu in the console header.
 *
 * Base UI's navigation menu opens on hover (and on focus/Enter for keyboard
 * users), so the POC names appear without a click; the click belongs to the
 * item, which navigates. Rendering each item as a Next `Link` keeps client-side
 * navigation and prefetching instead of a full page load.
 */
export function PocNav() {
  return (
    <NavigationMenu>
      <NavigationMenuList>
        <NavigationMenuItem>
          <NavigationMenuTrigger className="font-normal text-muted-foreground data-popup-open:text-foreground hover:text-foreground">
            POCs
          </NavigationMenuTrigger>

          <NavigationMenuContent>
            <ul className="grid w-[20rem] gap-1">
              {pocs.map((poc) => (
                <li key={poc.href}>
                  <NavigationMenuLink
                    render={<Link href={poc.href} />}
                    className="flex-col items-start gap-1"
                  >
                    <span className="font-medium">{poc.title}</span>
                    <span className="text-xs leading-snug text-muted-foreground">
                      {poc.description}
                    </span>
                  </NavigationMenuLink>
                </li>
              ))}
            </ul>
          </NavigationMenuContent>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  );
}
