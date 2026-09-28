import { Badge } from "@/components/ui/badge";
import type { TrackingStatus } from "@/lib/tracking/types";

/** Active sessions pulse, so a live one stands out in a long list. */
export function TrackingStatusBadge({ status }: { status: TrackingStatus }) {
  if (status === "COMPLETED") return <Badge variant="outline">Completed</Badge>;

  return (
    <Badge variant="secondary">
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
        <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
      </span>
      Active
    </Badge>
  );
}
