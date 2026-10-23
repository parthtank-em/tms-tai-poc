import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { TripPlanner } from "../../trip-planner";

import { Button } from "@/components/ui/button";
import { findPlannedPath, findTrip } from "@/lib/radar/service";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Edit Radar trip · FreightID",
  description: "Change a planned trip's source, destination or geofences.",
};

/** Only a PLANNED trip can be edited; anything else goes back to its page. */
export default async function EditRadarTripPage({ params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params;
  const [trip, path] = await Promise.all([findTrip(tripId), findPlannedPath(tripId)]);

  if (!trip) notFound();
  if (trip.status !== "PLANNED") redirect(`/radar-tracking/${tripId}`);

  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-10">
      <Button
        render={<Link href={`/radar-tracking/${tripId}`} />}
        variant="ghost"
        size="sm"
        className="-ml-2.5 mb-4"
      >
        <ArrowLeftIcon />
        Back to trip
      </Button>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Edit trip <span className="font-mono text-xl">{trip.id.slice(0, 8)}</span>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Possible until a driver starts the trip.
        </p>
      </header>

      <TripPlanner
        trip={{
          id: trip.id,
          start: trip.start,
          destination: trip.destination,
          route: trip.planned ? { ...trip.planned, path: path ?? [] } : null,
        }}
      />
    </main>
  );
}
