import { Simulator } from "./simulator";

export const metadata = {
  title: "Radar simulator · FreightID",
  description: "Drive a Radar trip from the browser the way the mobile app will.",
};

export default function RadarSimulatorPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Radar simulator</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Stands in for the mobile app: starts a trip, sends a moving position to Radar with the web
          SDK, and forwards the same points for the route line. Radar evaluates the geofences and
          the trip and reports back by webhook.
        </p>
      </header>

      <Simulator />
    </main>
  );
}
