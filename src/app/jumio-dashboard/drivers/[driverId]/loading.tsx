import { CardSkeleton, PageSkeleton } from "@/components/page-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** Shown while one driver and their verifications are queried. */
export default function Loading() {
  return (
    <PageSkeleton width="4xl">
      <div className="mb-6 space-y-2">
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-8 w-52" />
      </div>

      <div className="space-y-6">
        <CardSkeleton rows={4} />
        <CardSkeleton rows={3} />
      </div>
    </PageSkeleton>
  );
}
