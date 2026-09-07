import { EyeIcon } from "lucide-react";
import Link from "next/link";

import { ShipmentStatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, formatDateTime, formatText } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { isDeliveryStop, isPickupStop } from "@/lib/tai/status";

import type { StopType } from "@/generated/prisma/enums";

// Shipments change whenever a TAI webhook lands, so this list is always read
// fresh rather than served from a cached render.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Shipments · FreightID",
  description: "Shipments synchronized from TAI.",
};

type StopDates = {
  type: StopType;
  windowStart: Date | null;
  appointmentTime: Date | null;
  actualArrivalAt: Date | null;
  actualDepartureAt: Date | null;
};

/** A date plus whether it already happened or is still only scheduled. */
type ResolvedDate = { value: Date | null; actual: boolean };

/**
 * Ship date is when the freight actually left the first collecting stop, and
 * falls back through the scheduled dates when it has not moved yet. Delivery
 * date is the mirror image at the last dropping stop.
 *
 * Both are derived rather than stored: TAI has no single "ship date" field, and
 * duplicating one onto Shipment would immediately drift from the stop rows.
 */
function shipmentDates(stops: StopDates[]): { ship: ResolvedDate; delivery: ResolvedDate } {
  const pickup = stops.find((stop) => isPickupStop(stop.type));
  const delivery = [...stops].reverse().find((stop) => isDeliveryStop(stop.type));

  const resolve = (stop: StopDates | undefined, actual: Date | null): ResolvedDate => {
    if (!stop) return { value: null, actual: false };
    if (actual) return { value: actual, actual: true };
    return { value: stop.appointmentTime ?? stop.windowStart, actual: false };
  };

  return {
    ship: resolve(pickup, pickup?.actualDepartureAt ?? pickup?.actualArrivalAt ?? null),
    delivery: resolve(delivery, delivery?.actualArrivalAt ?? null),
  };
}

/** Scheduled dates are italic and muted so a plan is never read as a fact. */
function DateCell({ date, label }: { date: ResolvedDate; label: string }) {
  if (!date.value) {
    return <span className="text-muted-foreground">—</span>;
  }

  return (
    <span
      className={date.actual ? "tabular-nums" : "tabular-nums text-muted-foreground italic"}
      title={date.actual ? `Actual ${label}` : `Scheduled — not yet ${label}`}
    >
      {formatDate(date.value)}
    </span>
  );
}

export default async function ShipmentsPage() {
  const shipments = await prisma.shipment.findMany({
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      taiShipmentId: true,
      customerName: true,
      carrierName: true,
      status: true,
      updatedAt: true,
      stops: {
        orderBy: { sequence: "asc" },
        select: {
          type: true,
          windowStart: true,
          appointmentTime: true,
          actualArrivalAt: true,
          actualDepartureAt: true,
        },
      },
    },
  });

  if (shipments.length === 0) {
    return (
      <main className="mx-auto w-full max-w-7xl px-6 py-10">
        <h1 className="mb-6 text-2xl font-semibold tracking-tight">Shipments</h1>
        <Card>
          <CardHeader>
            <CardTitle>No shipments yet</CardTitle>
            <CardDescription>
              Shipments appear here as soon as TAI sends them through.
            </CardDescription>
          </CardHeader>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-10">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Shipments</h1>
        <p className="text-sm text-muted-foreground">{shipments.length} synchronized from TAI</p>
      </header>

      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Shipment ID</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Ship date</TableHead>
                <TableHead>Delivery date</TableHead>
                <TableHead>Carrier</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last updated</TableHead>
                <TableHead className="w-10 text-right">
                  <span className="sr-only">View</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shipments.map((shipment) => {
                const { ship, delivery } = shipmentDates(shipment.stops);
                const href = `/shipments/${shipment.id}`;

                return (
                  <TableRow key={shipment.id}>
                    <TableCell>
                      <Link
                        href={href}
                        className="font-medium tabular-nums underline-offset-4 hover:underline"
                      >
                        {shipment.taiShipmentId ?? "—"}
                      </Link>
                    </TableCell>

                    <TableCell
                      className="max-w-[16rem] truncate"
                      title={shipment.customerName ?? ""}
                    >
                      {formatText(shipment.customerName)}
                    </TableCell>

                    <TableCell className="whitespace-nowrap">
                      <DateCell date={ship} label="shipped" />
                    </TableCell>

                    <TableCell className="whitespace-nowrap">
                      <DateCell date={delivery} label="delivered" />
                    </TableCell>

                    <TableCell
                      className="max-w-[14rem] truncate"
                      title={shipment.carrierName ?? ""}
                    >
                      {formatText(shipment.carrierName)}
                    </TableCell>

                    <TableCell>
                      <ShipmentStatusBadge status={shipment.status} />
                    </TableCell>

                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(shipment.updatedAt)}
                    </TableCell>

                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`View shipment ${shipment.taiShipmentId ?? ""}`}
                        render={<Link href={href} />}
                      >
                        <EyeIcon />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </Card>
    </main>
  );
}
