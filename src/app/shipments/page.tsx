import Link from "next/link";

import { ShipmentStatusBadge } from "@/components/status-badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, formatLocation, formatText } from "@/lib/format";
import { prisma } from "@/lib/prisma";

// Shipments change whenever a TAI webhook lands, so this list is always read
// fresh rather than served from a cached render.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Shipments · FreightID",
  description: "Shipments synchronized from TAI.",
};

function stopSummary(stops: { type: string; city: string | null; state: string | null; postalCode: string | null }[]) {
  const pickup = stops.find((stop) => stop.type === "PICKUP") ?? stops.at(0);
  const delivery = [...stops].reverse().find((stop) => stop.type === "DELIVERY") ?? stops.at(-1);

  return {
    origin: pickup ? formatLocation(pickup) : "—",
    destination: delivery && delivery !== pickup ? formatLocation(delivery) : "—",
  };
}

export default async function ShipmentsPage() {
  const shipments = await prisma.shipment.findMany({
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      taiShipmentId: true,
      status: true,
      shipmentType: true,
      serviceLevel: true,
      carrierName: true,
      proNumber: true,
      updatedAt: true,
      stops: {
        orderBy: { sequence: "asc" },
        select: { type: true, city: true, state: true, postalCode: true },
      },
      _count: { select: { stops: true, events: true, alerts: true } },
    },
  });

  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Shipments</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {shipments.length === 0
            ? "Nothing synchronized from TAI yet."
            : `${shipments.length} shipment${shipments.length === 1 ? "" : "s"} synchronized from TAI.`}
        </p>
      </header>

      {shipments.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No shipments yet</CardTitle>
            <CardDescription>
              Shipments appear here as soon as TAI sends them through.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>TAI ID</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Origin</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead>Carrier</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>PRO</TableHead>
                  <TableHead className="text-right">Stops</TableHead>
                  <TableHead className="text-right">Events</TableHead>
                  <TableHead className="text-right">Last update</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shipments.map((shipment) => {
                  const { origin, destination } = stopSummary(shipment.stops);

                  return (
                    // `relative` + the stretched link below turns the whole row
                    // into one real anchor: keyboard focusable and
                    // right-clickable, without needing a client component.
                    <TableRow key={shipment.id} className="relative cursor-pointer">
                      <TableCell>
                        <Link
                          href={`/shipments/${shipment.id}`}
                          className="font-medium underline-offset-4 after:absolute after:inset-0 hover:underline"
                        >
                          {shipment.taiShipmentId ?? "—"}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <ShipmentStatusBadge status={shipment.status} />
                      </TableCell>
                      <TableCell>{origin}</TableCell>
                      <TableCell>{destination}</TableCell>
                      <TableCell>{formatText(shipment.carrierName)}</TableCell>
                      <TableCell>
                        {formatText(
                          [shipment.shipmentType, shipment.serviceLevel].filter(Boolean).join(" · "),
                        )}
                      </TableCell>
                      <TableCell>{formatText(shipment.proNumber)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {shipment._count.stops}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {shipment._count.events}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap text-muted-foreground">
                        {formatDateTime(shipment.updatedAt)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </main>
  );
}
