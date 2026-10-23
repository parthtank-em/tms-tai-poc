import { EyeIcon, PlusIcon, SmartphoneIcon } from "lucide-react";
import Link from "next/link";

import { TrackingStatusBadge } from "@/components/tracking/tracking-status-badge";
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
import { formatDateTime } from "@/lib/format";
import { getRadarConfig, getRadarWebhookToken } from "@/lib/radar/config";
import { arrivalTime, formatMinutes } from "@/lib/tracking/display";
import { getGoogleRoutesKey } from "@/lib/tracking/google-routes";
import { listSessions } from "@/lib/tracking/service";

// A device can start a session at any moment, so the list is always read fresh.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Location tracking · FreightID",
  description: "Trips planned here with Google routing and tracked with the Radar SDK: geofence events, trip status and ETA.",
};

export default async function TrackingSessionsPage() {
  const sessions = await listSessions();
  const missing = [
    !getGoogleRoutesKey() && "GOOGLE_MAPS_SERVER_API_KEY / NEXT_PUBLIC_GOOGLE_MAPS_API_KEY",
    !getRadarConfig() && "RADAR_SECRET_KEY / NEXT_PUBLIC_RADAR_PUBLISHABLE_KEY",
    !getRadarWebhookToken() && "RADAR_WEBHOOK_TOKEN",
  ].filter(Boolean);

  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-10">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tracking sessions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Plan a trip here (route from Google); a driver starts it from the mobile app. Radar then
            decides when the device enters or exits a fence and computes the ETA (car mode).
          </p>
        </div>

        <div className="flex gap-2">
          <Button render={<Link href="/tracking/simulator" />} variant="outline">
            <SmartphoneIcon />
            Simulator
          </Button>
          <Button render={<Link href="/tracking/new" />}>
            <PlusIcon />
            Add trip
          </Button>
        </div>
      </header>

      {missing.length > 0 && (
        <p className="mb-6 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Not configured: <code className="font-mono">{missing.join(", ")}</code>. See{" "}
          <code className="font-mono">.env.example</code>.
        </p>
      )}

      {sessions.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No sessions yet</CardTitle>
            <CardDescription>
              <Link href="/tracking/new" className="underline underline-offset-4">
                Add a trip
              </Link>
              , then start it from the mobile app or the{" "}
              <Link href="/tracking/simulator" className="underline underline-offset-4">
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
                <TableHead>Session</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>ETA</TableHead>
                <TableHead>Arrived</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => (
                <TableRow key={session.id}>
                  <TableCell className="font-mono text-xs" title={session.id}>
                    {session.id.slice(0, 8)}
                  </TableCell>
                  <TableCell>
                    {session.startedAt ? (
                      formatDateTime(new Date(session.startedAt))
                    ) : (
                      <span className="text-muted-foreground">Not started</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {session.eta ? (
                      <>
                        {formatMinutes(session.eta.minutes)}
                        <span className="block text-xs text-muted-foreground">
                          {formatDateTime(arrivalTime(session))}
                        </span>
                      </>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell>
                    {formatDateTime(session.arrivedAt ? new Date(session.arrivedAt) : null)}
                  </TableCell>
                  <TableCell>
                    <TrackingStatusBadge status={session.status} />
                  </TableCell>
                  <TableCell>
                    <Button
                      render={<Link href={`/tracking/${session.id}`} />}
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
