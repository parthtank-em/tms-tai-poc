import { VehicleLookup } from "./vehicle-lookup";

export const metadata = {
  title: "PlateLookup · FreightID",
  description: "Look up a vehicle's history by VIN, or by state and plate.",
};

export default function PlateLookupPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">PlateLookup Integration</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Look up a vehicle by VIN, or by state and plate, against the PlateLookup API.
        </p>
      </header>

      <VehicleLookup />
    </main>
  );
}
