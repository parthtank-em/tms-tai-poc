import { CardSkeleton, PageSkeleton } from "@/components/page-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** Shown while the driver behind the consent screen is loaded. */
export default function Loading() {
  return (
    <PageSkeleton width="xl">
      <Skeleton className="mb-6 h-4 w-32" />
      <CardSkeleton rows={4} />
    </PageSkeleton>
  );
}
