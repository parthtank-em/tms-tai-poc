import { EyeIcon, SmartphoneIcon } from "lucide-react";
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
import { formatDateTime, formatNumber } from "@/lib/format";
import { listSessions } from "@/lib/tracking/service";

// A device can start a session at any moment, so the list is always read fresh.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Location tracking · FreightID",
  description: "Tracking sessions reported by the mobile app.",
};

export default async function TrackingSessionsPage() {
  const sessions = await listSessions();

  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-10">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tracking sessions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            One row per press of Start on a device. Open a session to see its route.
          </p>
        </div>

        <Button render={<Link href="/tracking/simulator" />} variant="outline">
          <SmartphoneIcon />
          Mobile simulator
        </Button>
      </header>

      {sessions.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No sessions yet</CardTitle>
            <CardDescription>
              Start one from the mobile app, or from the{" "}
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
                <TableHead>Device</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Ended</TableHead>
                <TableHead className="text-right">Points</TableHead>
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
                  <TableCell>{session.deviceId}</TableCell>
                  <TableCell>{formatDateTime(new Date(session.startedAt))}</TableCell>
                  <TableCell>
                    {formatDateTime(session.endedAt ? new Date(session.endedAt) : null)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(session.locationCount)}
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
