import Link from "next/link";
import { notFound } from "next/navigation";

import { ConsentForm } from "./consent-form";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Verify identity · FreightID",
  description: "Consent to identity verification.",
};

/**
 * The consent screen that must come before any credential acquisition (§2.4, §9).
 *
 * Consent is recorded server-side when `/api/jumio/start` runs — timestamp and
 * IP — and sent to Jumio in the account call. This page only collects it.
 */
export default async function ConsentPage({
  params,
}: {
  params: Promise<{ driverId: string }>;
}) {
  const { driverId } = await params;

  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: { id: true, name: true },
  });

  if (!driver) notFound();

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-10">
      <div className="mb-6">
        <Link
          href={`/jumio-dashboard/drivers/${driver.id}`}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← {driver.name}
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Verify your identity</CardTitle>
        </CardHeader>
        <CardContent>
          <ConsentForm driverId={driver.id} driverName={driver.name} />
        </CardContent>
      </Card>
    </main>
  );
}
