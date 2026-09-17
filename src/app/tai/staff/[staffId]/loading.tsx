import { CardSkeleton, PageSkeleton } from "@/components/page-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** Shown while the one staff member is fetched from TAI. */
export default function Loading() {
  return (
    <PageSkeleton width="4xl">
      <Skeleton className="h-4 w-20" />

      <div className="mt-4 mb-8 space-y-2">
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-5 w-20" />
        </div>
        <Skeleton className="h-4 w-40" />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <CardSkeleton rows={6} />
        <CardSkeleton rows={4} />
      </div>
    </PageSkeleton>
  );
}
