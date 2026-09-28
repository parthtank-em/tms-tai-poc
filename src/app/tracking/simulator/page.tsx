import { Simulator } from "./simulator";

export const metadata = {
  title: "Mobile simulator · FreightID",
  description: "Drive the tracking API the way the mobile app will.",
};

export default function SimulatorPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Mobile simulator</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Stands in for the mobile app: starts a session, reports a moving position, queues points
          while offline and uploads them in bulk on reconnect. It calls the same endpoints a device
          would.
        </p>
      </header>

      <Simulator />
    </main>
  );
}
