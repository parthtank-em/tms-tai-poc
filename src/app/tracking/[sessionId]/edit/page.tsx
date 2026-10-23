import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { SessionPlanner } from "../../session-planner";

import { Button } from "@/components/ui/button";
import { findPlannedPath, findSession } from "@/lib/tracking/service";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Edit tracking trip · FreightID",
  description: "Change a planned trip's source, destination or geofences.",
};

/** Only a PLANNED session can be edited; anything else goes back to its page. */
export default async function EditTrackingSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const [session, path] = await Promise.all([findSession(sessionId), findPlannedPath(sessionId)]);

  if (!session) notFound();
  if (session.status !== "PLANNED") redirect(`/tracking/${sessionId}`);

  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-10">
      <Button
        render={<Link href={`/tracking/${sessionId}`} />}
        variant="ghost"
        size="sm"
        className="-ml-2.5 mb-4"
      >
        <ArrowLeftIcon />
        Back to session
      </Button>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Edit trip <span className="font-mono text-xl">{session.id.slice(0, 8)}</span>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">Possible until a driver starts the trip.</p>
      </header>

      <SessionPlanner
        trip={{
          id: session.id,
          start: session.start,
          destination: session.destination,
          route: session.planned ? { ...session.planned, path: path ?? [] } : null,
        }}
      />
    </main>
  );
}
