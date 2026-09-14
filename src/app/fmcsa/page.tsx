import { CarrierLookup } from "./carrier-lookup";

export const metadata = {
  title: "FMCSA · FreightID",
  description: "Look up a motor carrier by USDOT number against the FMCSA QCMobile API.",
};

export default function FmcsaPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">FMCSA Integration</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Enter a USDOT number to fetch the carrier from the FMCSA QCMobile API.
        </p>
      </header>

      <CarrierLookup />
    </main>
  );
}
