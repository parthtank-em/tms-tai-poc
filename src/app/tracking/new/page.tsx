import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";

import { SessionPlanner } from "../session-planner";

import { Button } from "@/components/ui/button";

export const metadata = {
  title: "New tracking trip · FreightID",
  description: "Plan a trip: source, destination and their geofences, with Google's route on a map.",
};

export default function NewTrackingSessionPage() {
  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-10">
      <Button render={<Link href="/tracking" />} variant="ghost" size="sm" className="-ml-2.5 mb-4">
        <ArrowLeftIcon />
        All sessions
      </Button>

      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">New trip</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The trip is saved as planned. A driver picks it in the mobile app and starts it — only then
          are its geofences created in Radar.
        </p>
      </header>

      <SessionPlanner />
    </main>
  );
}
