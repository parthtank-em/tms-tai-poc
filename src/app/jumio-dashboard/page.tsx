export const metadata = {
  title: "Jumio Dashboard · FreightID",
  description: "Jumio identity verification.",
};

/**
 * Reachable by URL only — nothing links here.
 *
 * Deliberately empty for now. Everything this page grows into (queries, UI,
 * helpers) belongs under the Jumio folders — `src/lib/jumio` and
 * `src/components/jumio` — and must not be folded into the TMS/TAI shipment
 * code, which is a separate integration with its own lifecycle.
 */
export default function JumioDashboardPage() {
  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Jumio Dashboard</h1>
    </main>
  );
}
