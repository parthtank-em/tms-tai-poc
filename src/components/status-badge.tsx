import { Badge } from "@/components/ui/badge";
import type { ShipmentStatus, TaiSyncStatus } from "@/generated/prisma/enums";
import { humanizeEnum } from "@/lib/format";

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "ghost";

/** Lifecycle position, roughly: pre-transit → outline, moving → secondary, done → default. */
const SHIPMENT_VARIANT: Record<ShipmentStatus, BadgeVariant> = {
  QUOTE: "outline",
  COMMITTED: "outline",
  READY: "outline",
  SENT: "outline",
  DISPATCHED: "secondary",
  IN_TRANSIT: "secondary",
  OUT_FOR_DELIVERY: "secondary",
  DELIVERED: "default",
  COMPLETE: "default",
  CANCELED: "destructive",
};

export function ShipmentStatusBadge({ status }: { status: ShipmentStatus }) {
  return <Badge variant={SHIPMENT_VARIANT[status]}>{humanizeEnum(status)}</Badge>;
}

/**
 * What reached TAI, in words an operator can act on. `NOT_APPLICABLE` covers
 * anything inbound (TAI already knows) and `HELD` anything we deliberately keep
 * local, so both read as "nothing to send" rather than as a failure.
 */
const SYNC_LABEL: Record<TaiSyncStatus, { text: string; variant: BadgeVariant } | null> = {
  NOT_APPLICABLE: null,
  HELD: { text: "Local only", variant: "ghost" },
  PENDING: { text: "Sending…", variant: "outline" },
  SYNCED: { text: "Sent", variant: "secondary" },
  FAILED: { text: "Failed", variant: "destructive" },
};

export function SyncStatusBadge({ status }: { status: TaiSyncStatus }) {
  const label = SYNC_LABEL[status];
  if (!label) return <span className="text-muted-foreground">—</span>;

  return <Badge variant={label.variant}>{label.text}</Badge>;
}
