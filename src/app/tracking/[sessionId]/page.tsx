import { ArrowLeftIcon, PencilIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DeleteSessionButton } from "./delete-session-button";
import { SessionMap } from "./session-map";

import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { getFeed } from "@/lib/tracking/service";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Tracking session · FreightID",
  description: "A tracking session's planned and driven route, Radar events and ETA on the map.",
};

/**
 * The whole feed is loaded here, so a completed session renders with no client
 * fetch. A planned or active one hands the feed's cursor to the map, which
 * polls on.
 */
export default async function TrackingSessionPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const feed = await getFeed(sessionId, null);

  if (!feed) notFound();

  const { session } = feed;

  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-10">
      <Button render={<Link href="/tracking" />} variant="ghost" size="sm" className="-ml-2.5 mb-4">
        <ArrowLeftIcon />
        All sessions
      </Button>

      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Session <span className="font-mono text-xl">{session.id.slice(0, 8)}</span>
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {session.startedAt
              ? `${session.deviceId} · started ${formatDateTime(new Date(session.startedAt))}`
              : `Planned ${formatDateTime(new Date(session.createdAt))} · not started`}
            {session.endedAt ? ` · ended ${formatDateTime(new Date(session.endedAt))}` : ""}
          </p>
        </div>

        {/* Only a planned session can change: once a phone has it, Radar has its fences. */}
        {session.status === "PLANNED" && (
          <div className="flex gap-2">
            <Button render={<Link href={`/tracking/${session.id}/edit`} />} variant="outline">
              <PencilIcon />
              Edit
            </Button>
            <DeleteSessionButton sessionId={session.id} />
          </div>
        )}
      </header>

      {/* Keyed on the status so a refresh after Start or Stop remounts the map
          with the server's feed rather than keeping stale client state. */}
      <SessionMap key={session.status} initial={feed} />
    </main>
  );
}
