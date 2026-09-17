import { HeadingSkeleton, PageSkeleton, TableSkeleton } from "@/components/page-skeleton";

/**
 * Shown while the roster is fetched.
 *
 * The slowest page in the POC: `listBrokerStaff` calls TAI on every request and
 * deliberately does not cache, so this fallback is the one an operator actually
 * sees for a moment rather than a flicker.
 */
export default function Loading() {
  return (
    <PageSkeleton width="7xl">
      <HeadingSkeleton />
      <TableSkeleton rows={8} />
    </PageSkeleton>
  );
}
