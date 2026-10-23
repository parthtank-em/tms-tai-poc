import { Badge } from "@/components/ui/badge";
import type { TrackingStatus, TripStatus } from "@/lib/tracking/types";

/** Our own lifecycle. Active sessions pulse, so a live one stands out in a long list. */
export function TrackingStatusBadge({ status }: { status: TrackingStatus }) {
  if (status === "COMPLETED") return <Badge variant="outline">Completed</Badge>;
  if (status === "PLANNED") {
    return (
      <Badge variant="outline" className="text-blue-700 dark:text-blue-400">
        Planned
      </Badge>
    );
  }

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

const TRIP_STATUS: Record<TripStatus, { label: string; className: string }> = {
  PENDING: { label: "Pending", className: "" },
  STARTED: { label: "Started", className: "text-blue-700 dark:text-blue-400" },
  APPROACHING: { label: "Approaching", className: "text-amber-700 dark:text-amber-400" },
  ARRIVED: { label: "Arrived", className: "text-emerald-700 dark:text-emerald-400" },
  COMPLETED: { label: "Completed", className: "" },
  CANCELED: { label: "Canceled", className: "text-destructive" },
  EXPIRED: { label: "Expired", className: "text-destructive" },
};

/** Radar's view of the session's trip. "—" until Radar has acknowledged it. */
export function TripStatusBadge({ status }: { status: TripStatus | null }) {
  if (!status) return <span className="text-muted-foreground">—</span>;

  const { label, className } = TRIP_STATUS[status];
  return (
    <Badge variant="outline" className={className}>
      {label}
    </Badge>
  );
}
