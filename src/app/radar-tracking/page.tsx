import { EyeIcon, SmartphoneIcon } from "lucide-react";
import Link from "next/link";

import { RadarTripStatusBadge, TripLifecycleBadge } from "@/components/radar-tracking/trip-badges";
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
import { formatDateTime, formatNumber } from "@/lib/format";
import { getRadarConfig, getRadarWebhookToken } from "@/lib/radar/config";
import { arrivalTime, formatMinutes } from "@/lib/radar/display";
import { listTrips } from "@/lib/radar/service";

// A device can start a trip at any moment, so the list is always read fresh.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Radar geofencing · FreightID",
  description: "Trips tracked with the Radar SDK: geofence events, trip status and ETA.",
};

export default async function RadarTripsPage() {
  const trips = await listTrips();
  const missing = [
    !getRadarConfig() && "RADAR_SECRET_KEY / NEXT_PUBLIC_RADAR_PUBLISHABLE_KEY",
    !getRadarWebhookToken() && "RADAR_WEBHOOK_TOKEN",
  ].filter(Boolean);

  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-10">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Radar trips</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Radar decides when a device enters or leaves a fence and computes the ETA (car mode).
            Open a trip to see its route and events.
          </p>
        </div>

        <Button render={<Link href="/radar-tracking/simulator" />} variant="outline">
          <SmartphoneIcon />
          Simulator
        </Button>
      </header>

      {missing.length > 0 && (
        <p className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Not configured: <code className="font-mono">{missing.join(", ")}</code>. See the Radar
          section of <code className="font-mono">.env.example</code>.
        </p>
      )}

      {trips.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No trips yet</CardTitle>
            <CardDescription>
              Start one from the mobile app, or from the{" "}
              <Link href="/radar-tracking/simulator" className="underline underline-offset-4">
                simulator
              </Link>
              .
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="rounded-xl border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Trip</TableHead>
                <TableHead>Device</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Radar status</TableHead>
                <TableHead>ETA</TableHead>
                <TableHead>Arrived</TableHead>
                <TableHead className="text-right">Points</TableHead>
                <TableHead className="text-right">Events</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {trips.map((trip) => (
                <TableRow key={trip.id}>
                  <TableCell className="font-mono text-xs" title={trip.id}>
                    {trip.id.slice(0, 8)}
                  </TableCell>
                  <TableCell>{trip.deviceId}</TableCell>
                  <TableCell>{formatDateTime(new Date(trip.startedAt))}</TableCell>
                  <TableCell>
                    <RadarTripStatusBadge status={trip.tripStatus} />
                  </TableCell>
                  <TableCell>
                    {trip.eta ? (
                      <>
                        {formatMinutes(trip.eta.minutes)}
                        <span className="block text-xs text-muted-foreground">
                          {formatDateTime(arrivalTime(trip))}
                        </span>
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {formatDateTime(trip.arrivedAt ? new Date(trip.arrivedAt) : null)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(trip.locationCount)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(trip.eventCount)}
                  </TableCell>
                  <TableCell>
                    <TripLifecycleBadge status={trip.status} />
                  </TableCell>
                  <TableCell>
                    <Button
                      render={<Link href={`/radar-tracking/${trip.id}`} />}
                      variant="ghost"
                      size="sm"
                    >
                      <EyeIcon />
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </main>
  );
}
