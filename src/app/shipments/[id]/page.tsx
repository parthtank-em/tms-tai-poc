import Link from "next/link";
import { notFound } from "next/navigation";

import { AlertsDialog } from "./alerts-dialog";
import {
  DriverDialog,
  LifecycleFeedback,
  StatusControls,
  StopControls,
} from "./lifecycle-controls";

import {
  ProcessingStatusBadge,
  ShipmentStatusBadge,
  SyncStatusBadge,
} from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatDateTime,
  formatDecimal,
  formatNumber,
  formatText,
  humanizeEnum,
} from "@/lib/format";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** Label/value row used across the summary cards. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(9rem,auto)_1fr] gap-4 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
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
      driver: true,
      stops: { orderBy: { sequence: "asc" } },
      events: { orderBy: { occurredAt: "desc" }, take: 50 },
      alerts: { orderBy: { createdAt: "desc" } },
      webhookEvents: { orderBy: { receivedAt: "desc" }, take: 10 },
    },
  });

  if (!shipment) {
    notFound();
  }

  return (
    <LifecycleFeedback>
    <main className="mx-auto w-full max-w-6xl px-6 py-10">
      <Link
        href="/shipments"
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        ← All shipments
      </Link>

      <header className="mt-4 mb-8 flex flex-wrap items-center gap-x-4 gap-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          TAI #{shipment.taiShipmentId ?? "—"}
        </h1>
        <ShipmentStatusBadge status={shipment.status} />
        {shipment.taiStatusLabel && shipment.taiStatusLabel !== humanizeEnum(shipment.status) ? (
          <span className="text-sm text-muted-foreground">
            TAI label: <code className="rounded bg-muted px-1 py-0.5 text-xs">{shipment.taiStatusLabel}</code>
          </span>
        ) : null}
        {shipment.loadHazmat ? <Badge variant="destructive">Hazmat</Badge> : null}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <StatusControls shipmentId={shipment.id} status={shipment.status} />
          <DriverDialog
            shipmentId={shipment.id}
            driverName={shipment.driver?.name ?? null}
            driverPhone={shipment.driver?.phone ?? null}
            verified={shipment.driver?.verificationStatus === "VERIFIED"}
          />
          <AlertsDialog
            shipmentId={shipment.id}
            initialOpenCount={shipment.alerts.filter((alert) => !alert.resolved).length}
          />
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Shipment</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              <Field label="Mode / service">
                {formatText([shipment.shipmentType, shipment.serviceLevel].filter(Boolean).join(" · "))}
              </Field>
              <Field label="Mileage">{formatDecimal(shipment.mileage, " mi")}</Field>
              <Field label="PRO number">{formatText(shipment.proNumber)}</Field>
              <Field label="BOL number">{formatText(shipment.bolNumber)}</Field>
              <Field label="PO number">{formatText(shipment.poNumber)}</Field>
              <Field label="Shipper reference">{formatText(shipment.shipperReference)}</Field>
              <Field label="Created">{formatDateTime(shipment.createdAt)}</Field>
              <Field label="Updated">{formatDateTime(shipment.updatedAt)}</Field>
              <Field label="Last seen from TAI">{formatDateTime(shipment.taiLastSeenAt)}</Field>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Load</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              <Field label="Description">{formatText(shipment.loadDescription)}</Field>
              <Field label="Quantity">{formatNumber(shipment.loadQuantity)}</Field>
              <Field label="Pieces">{formatNumber(shipment.loadPieces)}</Field>
              <Field label="Weight">{formatDecimal(shipment.loadWeightLb, " lb")}</Field>
              <Field label="Hazmat">{shipment.loadHazmat ? "Yes" : "No"}</Field>
              <Field label="Dimensions">
                {shipment.loadDimensions ? (
                  <code className="text-xs break-all">{JSON.stringify(shipment.loadDimensions)}</code>
                ) : (
                  "—"
                )}
              </Field>
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
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Driver</CardTitle>
            <CardDescription>
              FreightID-owned. Driver assignment is not pushed to TAI — held pending §5.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              <Field label="Assigned driver">{formatText(shipment.driver?.name)}</Field>
              <Field label="Phone">{formatText(shipment.driver?.phone)}</Field>
              <Field label="Verification">
                {shipment.driver ? humanizeEnum(shipment.driver.verificationStatus) : "—"}
              </Field>
              <Field label="Assigned at">{formatDateTime(shipment.driverAssignedAt)}</Field>
              <Field label="Identity verified">
                {formatDateTime(shipment.driverIdentityVerifiedAt)}
              </Field>
              <Separator className="my-2" />
              <Field label="Driver name (from TAI)">{formatText(shipment.secondaryDriverName)}</Field>
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
          <CardDescription>
            A stop needs a TAI stop ID before it can be addressed by{" "}
            <code className="text-xs">PUT /Tracking/{"{shipmentStopId}"}</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 pt-6">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-right">#</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>TAI stop ID</TableHead>
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
                    <TableCell colSpan={10} className="text-center text-muted-foreground">
                      No stops on this shipment.
                    </TableCell>
                  </TableRow>
                ) : (
                  shipment.stops.map((stop) => (
                    <TableRow key={stop.id}>
                      <TableCell className="text-right tabular-nums">{stop.sequence}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{humanizeEnum(stop.type)}</Badge>
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {stop.taiShipmentStopId ?? (
                          <span className="text-muted-foreground">not provided</span>
                        )}
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
                          stopType={stop.type}
                          hasArrived={stop.actualArrivalAt !== null}
                          hasDeparted={stop.actualDepartureAt !== null}
                          canSync={stop.taiShipmentStopId !== null}
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
                    <TableHead>TAI alert ID</TableHead>
                    <TableHead>Resolved</TableHead>
                    <TableHead>Raised</TableHead>
                    <TableHead>Resolved at</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shipment.alerts.map((alert) => (
                    <TableRow key={alert.id}>
                      <TableCell>{alert.alertType}</TableCell>
                      <TableCell className="tabular-nums">
                        {alert.taiAlertId ?? (
                          <span className="text-muted-foreground">not sent</span>
                        )}
                      </TableCell>
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

      <Card className="mt-6 overflow-hidden p-0">
        <CardHeader className="p-6 pb-0">
          <CardTitle>Event history</CardTitle>
          <CardDescription>Append-only audit trail, newest first.</CardDescription>
        </CardHeader>
        <CardContent className="p-0 pt-6">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Occurred</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>TAI sync</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shipment.events.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      No events recorded.
                    </TableCell>
                  </TableRow>
                ) : (
                  shipment.events.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDateTime(event.occurredAt)}
                      </TableCell>
                      <TableCell className="font-medium">{humanizeEnum(event.type)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{humanizeEnum(event.source)}</Badge>
                      </TableCell>
                      <TableCell>
                        <SyncStatusBadge status={event.taiSyncStatus} />
                      </TableCell>
                      <TableCell className="max-w-md">
                        {event.details ? (
                          <code className="text-xs break-all text-muted-foreground">
                            {JSON.stringify(event.details)}
                          </code>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-6 overflow-hidden p-0">
        <CardHeader className="p-6 pb-0">
          <CardTitle>Inbound deliveries</CardTitle>
          <CardDescription>
            The 10 most recent TAI webhooks matched to this shipment. TAI never re-sends, so this log
            is the only record a delivery arrived.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 pt-6">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Received</TableHead>
                  <TableHead>Webhook</TableHead>
                  <TableHead>Auth</TableHead>
                  <TableHead>Processing</TableHead>
                  <TableHead className="text-right">Attempts</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shipment.webhookEvents.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      No deliveries linked to this shipment.
                    </TableCell>
                  </TableRow>
                ) : (
                  shipment.webhookEvents.map((delivery) => (
                    <TableRow key={delivery.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatDateTime(delivery.receivedAt)}
                      </TableCell>
                      <TableCell>{humanizeEnum(delivery.type)}</TableCell>
                      <TableCell>
                        <Badge
                          variant={delivery.authResult === "AUTHORIZED" ? "outline" : "destructive"}
                        >
                          {humanizeEnum(delivery.authResult)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <ProcessingStatusBadge status={delivery.processingStatus} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {delivery.attemptCount}
                      </TableCell>
                      <TableCell className="max-w-sm text-destructive">
                        <span className="text-xs break-words">{delivery.error ?? ""}</span>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </main>
    </LifecycleFeedback>
  );
}
