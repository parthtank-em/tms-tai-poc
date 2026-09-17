import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading skeletons for the `loading.tsx` of each server-rendered page.
 *
 * These pages fetch on the server — a Prisma query, or a live call to TAI — so
 * between the click and the first paint there is nothing on screen and no
 * indication anything is happening. A skeleton in the shape of the page that is
 * coming says both that the app is working and roughly what will arrive.
 *
 * Kept as plain markup with no client JavaScript: Next prefetches the fallback,
 * so the cheaper it is, the sooner it appears.
 */

/** Tailwind needs whole class names, so the widths are spelled out. */
const WIDTHS = {
  xl: "max-w-xl",
  "4xl": "max-w-4xl",
  "6xl": "max-w-6xl",
  "7xl": "max-w-7xl",
} as const;

export function PageSkeleton({
  width = "7xl",
  children,
}: {
  width?: keyof typeof WIDTHS;
  children: React.ReactNode;
}) {
  return (
    // `role="status"` with an sr-only label: a screen reader hears that the
    // page is loading, where a sighted user sees the shimmer.
    <main
      role="status"
      aria-busy="true"
      className={`mx-auto w-full ${WIDTHS[width]} px-6 py-10`}
    >
      <span className="sr-only">Loading…</span>
      {children}
    </main>
  );
}

/** The page title, and the count or badge that usually sits opposite it. */
export function HeadingSkeleton({ trailing = true }: { trailing?: boolean }) {
  return (
    <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
      <Skeleton className="h-8 w-48" />
      {trailing ? <Skeleton className="h-4 w-24" /> : null}
    </div>
  );
}

/**
 * A table's worth of rows. The header bar is solid and the body rows fade down
 * the list, so the eye reads it as a table rather than as a block of grey.
 */
export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="border-b px-6 py-3">
        <Skeleton className="h-4 w-full max-w-md" />
      </div>

      <div className="divide-y">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex items-center gap-4 px-6 py-4">
            <Skeleton className="h-4 w-full" style={{ opacity: 1 - index * 0.12 }} />
          </div>
        ))}
      </div>
    </Card>
  );
}

/** A summary card: a title, then a handful of label/value rows. */
export function CardSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <Card className="p-6">
      <Skeleton className="mb-4 h-5 w-32" />

      <div className="space-y-3">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-4">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-4 w-full max-w-48" />
          </div>
        ))}
      </div>
    </Card>
  );
}
