import { ArrowLeftIcon, PencilIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DeleteTripButton } from "./delete-trip-button";
import { TripMap } from "./trip-map";

import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { getFeed } from "@/lib/radar/service";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Radar trip · FreightID",
  description: "A Radar trip's planned and driven route, geofence events and ETA on the map.",
};

/**
 * The whole feed is loaded here, so a completed trip renders with no client
 * fetch. A planned or active one hands the feed's cursor to the map, which
 * polls on.
 */
export default async function RadarTripPage({ params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params;
  const feed = await getFeed(tripId, null);

  if (!feed) notFound();

  const { trip } = feed;

  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-10">
      <Button
        render={<Link href="/radar-tracking" />}
        variant="ghost"
        size="sm"
        className="-ml-2.5 mb-4"
      >
        <ArrowLeftIcon />
        All trips
      </Button>

      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Trip <span className="font-mono text-xl">{trip.id.slice(0, 8)}</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {trip.startedAt
              ? `${trip.deviceId} · started ${formatDateTime(new Date(trip.startedAt))}`
              : `Planned ${formatDateTime(new Date(trip.createdAt))} · not started`}
            {trip.endedAt ? ` · ended ${formatDateTime(new Date(trip.endedAt))}` : ""}
          </p>
        </div>

        {/* Only a planned trip can change: once a phone has it, Radar has its fences. */}
        {trip.status === "PLANNED" && (
          <div className="flex gap-2">
            <Button render={<Link href={`/radar-tracking/${trip.id}/edit`} />} variant="outline">
              <PencilIcon />
              Edit
            </Button>
            <DeleteTripButton tripId={trip.id} />
          </div>
        )}
      </header>

      {/* Keyed on the lifecycle so a refresh after Start or Stop remounts the
          map with the server's feed rather than keeping stale client state. */}
      <TripMap key={trip.status} initial={feed} />
    </main>
  );
}
