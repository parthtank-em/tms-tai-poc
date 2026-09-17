import { HeadingSkeleton, PageSkeleton, TableSkeleton } from "@/components/page-skeleton";

/** Shown while the shipment list is queried. */
export default function Loading() {
  return (
    <PageSkeleton width="7xl">
      <HeadingSkeleton />
      <TableSkeleton rows={6} />
    </PageSkeleton>
  );
}
