import { PageSkeleton, TableSkeleton } from "@/components/page-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** Shown while the driver list is queried. */
export default function Loading() {
  return (
    <PageSkeleton width="7xl">
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <div className="space-y-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Skeleton className="h-4 w-20" />
      </div>

      <TableSkeleton rows={6} />
    </PageSkeleton>
  );
}
