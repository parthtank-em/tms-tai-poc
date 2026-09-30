import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { SessionMap } from "./session-map";

import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { findSession, listLocations } from "@/lib/tracking/service";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Tracking session · FreightID",
  description: "A tracking session's route on the map.",
};

/**
 * The route is loaded here in full, so a completed session renders with no
 * client fetch at all. An active one hands the same payload's cursor to the
 * map, which polls from there for whatever arrives next.
 */
export default async function TrackingSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  const [session, locations] = await Promise.all([
    findSession(sessionId),
    listLocations(sessionId, null),
  ]);

  if (!session || !locations) notFound();

  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-10">
      <Button render={<Link href="/tracking" />} variant="ghost" size="sm" className="-ml-2.5 mb-4">
        <ArrowLeftIcon />
        All sessions
      </Button>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Session <span className="font-mono text-xl">{session.id.slice(0, 8)}</span>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {session.deviceId} · started {formatDateTime(new Date(session.startedAt))}
          {session.endedAt ? ` · ended ${formatDateTime(new Date(session.endedAt))}` : ""}
        </p>
      </header>

      <SessionMap initial={locations} geofence={session.geofence} />
    </main>
  );
}
