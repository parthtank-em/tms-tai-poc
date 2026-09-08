import Link from "next/link";
import { notFound } from "next/navigation";

import { ResultPoller } from "./result-poller";

import {
  CapabilityBadge,
  RiskScore,
  VerificationDecisionBadge,
  VerificationStatusBadge,
} from "@/components/jumio/verification-badges";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { humanizeEnum } from "@/lib/format";
import { toVerificationView, verificationPhase } from "@/lib/jumio/presenter";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Identity verification · FreightID",
  description: "Identity verification result.",
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-4 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/**
 * Where Jumio's Web Client returns the driver (§10, §18).
 *
 * Both the success and the error URL point here. Which one the browser came
 * back through is *not* what decides the outcome — the rendered state is read
 * from the database, which only a callback plus retrieval can move. Arriving
 * via the error URL merely adds a note that the capture journey reported a
 * problem.
 */
export default async function VerificationResultPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const query = await searchParams;

  const verification = await prisma.driverVerification.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      decision: true,
      riskScore: true,
      documentType: true,
      documentSubType: true,
      extractedFirstName: true,
      extractedLastName: true,
      extractedDob: true,
      licenseNumber: true,
      licenseExpiry: true,
      issuingCountry: true,
      issuingState: true,
      livenessDecision: true,
      faceMatchDecision: true,
      error: true,
      startedAt: true,
      completedAt: true,
      driver: { select: { id: true, name: true } },
    },
  });

  if (!verification) notFound();

  const view = toVerificationView(verification);
  const phase = verificationPhase(verification.status, verification.decision);
  // The Web Client appends its own parameters on the way back. Any of these
  // means the capture journey reported a problem — none of them decides the
  // verification, which is read from the database below.
  const acquisitionError =
    typeof query.errorCode === "string" ||
    query.acquisitionStatus === "ERROR" ||
    query.transactionStatus === "ERROR";

  const driverHref = `/jumio-dashboard/drivers/${verification.driver.id}`;

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-10">
      {phase === "pending" && (
        <ResultPoller driverId={verification.driver.id} status={verification.status} />
      )}

      <div className="mb-6">
        <Link
          href={driverHref}
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← {verification.driver.name}
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Identity Verification</CardTitle>
          <CardDescription>
            {phase === "pending" && "We are waiting for the identity verification result."}
            {phase === "passed" && "Identity confirmed."}
            {phase === "failed" && "This verification did not pass."}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {acquisitionError && phase === "pending" && (
            <p className="text-sm text-destructive">
              Jumio reported a problem during capture. The result below is still whatever Jumio
              last told us — it updates on its own if a result arrives.
            </p>
          )}

          <dl className="divide-y">
            <Field label="Status">
              <VerificationStatusBadge status={verification.status} />
            </Field>
            <Field label="Decision">
              <VerificationDecisionBadge decision={verification.decision} />
            </Field>
            <Field label="Risk score">
              <RiskScore score={view.riskScore} />
            </Field>

            {phase === "passed" && (
              <>
                <Field label="Document">
                  {view.document.type ? humanizeEnum(view.document.type) : "—"}
                </Field>
                <Field label="Face match">
                  <CapabilityBadge label={view.faceMatch} />
                </Field>
                <Field label="Liveness">
                  <CapabilityBadge label={view.liveness} />
                </Field>
              </>
            )}
          </dl>

          {phase === "pending" ? (
            <p className="text-sm text-muted-foreground">
              This page refreshes itself when the result arrives. You can safely leave it.
            </p>
          ) : (
            <div className="flex gap-3">
              <Button render={<Link href={driverHref} />} variant="outline">
                Back to driver
              </Button>
              {phase === "failed" && (
                <Button render={<Link href={`${driverHref}/consent`} />}>Try again</Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
