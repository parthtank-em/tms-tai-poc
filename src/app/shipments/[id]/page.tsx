import Link from "next/link";
import { notFound } from "next/navigation";

import { AlertsDialog } from "./alerts-dialog";
import { LifecycleFeedback, StatusControls, StopControls } from "./lifecycle-controls";

import { ShipmentStatusBadge, SyncStatusBadge } from "@/components/status-badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, formatDecimal, formatText, humanizeEnum } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { isDeliveryStop, isPickupStop, stopTypeLabel } from "@/lib/tai/status";

/** `datetime-local` value for a UTC timestamp, so the field shows UTC too. */
function toDateTimeLocal(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 16) : null;
}

export const dynamic = "force-dynamic";

/** Label/value row used across the summary cards. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-4 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** Section title for an accordion panel, with the row count beside it. */
function PanelTitle({ title, count }: { title: string; count: number }) {
  return (
    <span className="flex items-baseline gap-2">
      {title}
      <span className="text-xs font-normal text-muted-foreground tabular-nums">{count}</span>
    </span>
  );
}

export default async function ShipmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const shipment = await prisma.shipment.findUnique({
    where: { id },
    include: {
      stops: { orderBy: { sequence: "asc" } },
      events: { orderBy: { occurredAt: "desc" }, take: 50 },
      alerts: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!shipment) {
    notFound();
  }

  const openAlerts = shipment.alerts.filter((alert) => !alert.resolved).length;

  return (
    <LifecycleFeedback>
      <main className="mx-auto w-full max-w-6xl px-6 py-10">
        <Link
          href="/shipments"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← All shipments
        </Link>

        <header className="mt-4 mb-8">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <h1 className="text-2xl font-semibold tracking-tight tabular-nums">
              TAI #{shipment.taiShipmentId ?? "—"}
            </h1>
            <ShipmentStatusBadge status={shipment.status} />
            {shipment.loadHazmat ? <Badge variant="destructive">Hazmat</Badge> : null}

            <div className="ml-auto flex flex-wrap items-center gap-2">
              <StatusControls shipmentId={shipment.id} status={shipment.status} />
              <AlertsDialog shipmentId={shipment.id} initialOpenCount={openAlerts} />
            </div>
          </div>

          {/* Customer earns the subtitle: it is what an operator recognises a
              load by, more than its TAI id. */}
          <p className="mt-1 text-sm text-muted-foreground">
            {formatText(shipment.customerName)}
          </p>
        </header>

        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Shipment</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="divide-y">
                <Field label="Customer">{formatText(shipment.customerName)}</Field>
                <Field label="Mode / service">
                  {formatText(
                    [shipment.shipmentType, shipment.serviceLevel].filter(Boolean).join(" · "),
                  )}
                </Field>
                <Field label="Mileage">{formatDecimal(shipment.mileage, " mi")}</Field>
                <Field label="PRO number">{formatText(shipment.proNumber)}</Field>
                <Field label="BOL number">{formatText(shipment.bolNumber)}</Field>
                <Field label="PO number">{formatText(shipment.poNumber)}</Field>
                <Field label="Shipper reference">{formatText(shipment.shipperReference)}</Field>
                <Field label="Last synced">{formatDateTime(shipment.taiLastSeenAt)}</Field>
                <Field label="Updated">{formatDateTime(shipment.updatedAt)}</Field>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Carrier</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="divide-y">
                <Field label="Name">{formatText(shipment.carrierName)}</Field>
                <Field label="MC number">{formatText(shipment.carrierMcNumber)}</Field>
                <Field label="SCAC">{formatText(shipment.carrierScac)}</Field>
                <Field label="Phone">{formatText(shipment.carrierPhone)}</Field>
                <Field label="Driver (from TAI)">
                  {formatText(shipment.secondaryDriverName)}
                </Field>
                <Field label="Driver phone (from TAI)">
                  {formatText(shipment.secondaryDriverPhone)}
                </Field>
              </dl>
            </CardContent>
          </Card>
        </div>

        <Card className="mt-6 overflow-hidden p-0">
          <CardHeader className="p-6 pb-0">
            <CardTitle>Stops</CardTitle>
          </CardHeader>
          <CardContent className="p-0 pt-6">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-right">#</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Company</TableHead>
                    <TableHead>Address</TableHead>
                    <TableHead>Window</TableHead>
                    <TableHead>Appointment</TableHead>
                    <TableHead>Actual arrival</TableHead>
                    <TableHead>POD signed by</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shipment.stops.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center text-muted-foreground">
                        No stops on this shipment.
                      </TableCell>
                    </TableRow>
                  ) : (
                    shipment.stops.map((stop) => (
                      <TableRow key={stop.id}>
                        <TableCell className="text-right tabular-nums">{stop.sequence}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{stopTypeLabel(stop.type)}</Badge>
                        </TableCell>
                        <TableCell>{formatText(stop.companyName)}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {formatText(
                            [stop.address1, stop.city, stop.state, stop.postalCode]
                              .filter(Boolean)
                              .join(", "),
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {stop.windowStart || stop.windowEnd
                            ? `${formatDateTime(stop.windowStart)} → ${formatDateTime(stop.windowEnd)}`
                            : "—"}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatDateTime(stop.appointmentTime)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {formatDateTime(stop.actualArrivalAt)}
                        </TableCell>
                        <TableCell>{formatText(stop.podSignedBy)}</TableCell>
                        <TableCell className="text-right">
                          <StopControls
                            shipmentId={shipment.id}
                            stopId={stop.id}
                            isPickup={isPickupStop(stop.type)}
                            isDelivery={isDeliveryStop(stop.type)}
                            hasArrived={stop.actualArrivalAt !== null}
                            hasDeparted={stop.actualDepartureAt !== null}
                            canSync={stop.taiShipmentStopId !== null}
                            windowStart={toDateTimeLocal(stop.windowStart)}
                            windowEnd={toDateTimeLocal(stop.windowEnd)}
                          />
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        {shipment.alerts.length > 0 ? (
          <Card className="mt-6 overflow-hidden p-0">
            <CardHeader className="p-6 pb-0">
              <CardTitle>Alerts</CardTitle>
            </CardHeader>
            <CardContent className="p-0 pt-6">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Resolved</TableHead>
                      <TableHead>Raised</TableHead>
                      <TableHead>Resolved at</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shipment.alerts.map((alert) => (
                      <TableRow key={alert.id}>
                        <TableCell>{alert.alertType}</TableCell>
                        <TableCell>
                          <Badge variant={alert.resolved ? "secondary" : "destructive"}>
                            {alert.resolved ? "Resolved" : "Open"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDateTime(alert.createdAt)}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDateTime(alert.resolvedAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {/* Both of these are diagnostic logs — useful when something looks
            wrong, noise the rest of the time. Collapsed by default. */}
        <Card className="mt-6 px-6 py-2">
          <Accordion>
            <AccordionItem value="events">
              <AccordionTrigger>
                <PanelTitle title="Activity" count={shipment.events.length} />
              </AccordionTrigger>
              <AccordionContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>When</TableHead>
                        <TableHead>Activity</TableHead>
                        <TableHead>Recorded by</TableHead>
                        <TableHead>Sent to TAI</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {shipment.events.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={4} className="text-center text-muted-foreground">
                            No events recorded.
                          </TableCell>
                        </TableRow>
                      ) : (
                        shipment.events.map((event) => (
                          <TableRow key={event.id}>
                            <TableCell className="whitespace-nowrap text-muted-foreground">
                              {formatDateTime(event.occurredAt)}
                            </TableCell>
                            <TableCell className="font-medium">
                              {humanizeEnum(event.type)}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {event.source === "FREIGHTID_INTERNAL" ? "FreightID" : "TAI"}
                            </TableCell>
                            <TableCell>
                              <SyncStatusBadge status={event.taiSyncStatus} />
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </AccordionContent>
            </AccordionItem>

          </Accordion>
        </Card>
      </main>
    </LifecycleFeedback>
  );
}
