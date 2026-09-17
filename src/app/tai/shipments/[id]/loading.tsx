import { CardSkeleton, PageSkeleton, TableSkeleton } from "@/components/page-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** Shown while one shipment, its stops, events and alerts are queried. */
export default function Loading() {
  return (
    <PageSkeleton width="6xl">
      {/* Stands in for the "← All shipments" link, so the top of the page does
          not shift once the real content arrives. */}
      <Skeleton className="h-4 w-28" />

      <div className="mt-4 mb-8 flex flex-wrap items-center gap-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-5 w-20" />
        <div className="ml-auto flex gap-2">
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-24" />
          <Skeleton className="h-8 w-24" />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <CardSkeleton rows={6} />
        <CardSkeleton rows={6} />
      </div>

      <div className="mt-6">
        <TableSkeleton rows={3} />
      </div>
    </PageSkeleton>
  );
}
