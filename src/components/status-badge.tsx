import { Badge } from "@/components/ui/badge";
import type {
  ShipmentStatus,
  TaiSyncStatus,
  WebhookProcessingStatus,
} from "@/generated/prisma/enums";
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

const SYNC_VARIANT: Record<TaiSyncStatus, BadgeVariant> = {
  NOT_APPLICABLE: "ghost",
  PENDING: "outline",
  SYNCED: "secondary",
  FAILED: "destructive",
  HELD: "outline",
};

export function SyncStatusBadge({ status }: { status: TaiSyncStatus }) {
  return <Badge variant={SYNC_VARIANT[status]}>{humanizeEnum(status)}</Badge>;
}

const PROCESSING_VARIANT: Record<WebhookProcessingStatus, BadgeVariant> = {
  PENDING: "outline",
  PROCESSING: "outline",
  PROCESSED: "secondary",
  FAILED: "destructive",
  SKIPPED: "ghost",
};

export function ProcessingStatusBadge({ status }: { status: WebhookProcessingStatus }) {
  return <Badge variant={PROCESSING_VARIANT[status]}>{humanizeEnum(status)}</Badge>;
}
