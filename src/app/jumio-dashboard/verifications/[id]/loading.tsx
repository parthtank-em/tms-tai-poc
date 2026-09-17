import { CardSkeleton, PageSkeleton } from "@/components/page-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

/** Shown while a verification result is loaded. */
export default function Loading() {
  return (
    <PageSkeleton width="xl">
      <Skeleton className="mb-6 h-4 w-32" />
      <CardSkeleton rows={5} />
    </PageSkeleton>
  );
}
