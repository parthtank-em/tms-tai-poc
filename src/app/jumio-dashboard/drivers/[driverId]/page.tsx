import Link from "next/link";
import { notFound } from "next/navigation";

import {
  CapabilityBadge,
  RiskScore,
  VerificationDecisionBadge,
  VerificationStatusBadge,
} from "@/components/jumio/verification-badges";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate, formatDateTime, formatText, humanizeEnum } from "@/lib/format";
import { toVerificationView, verificationPhase } from "@/lib/jumio/presenter";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** Label/value row, matching the shipment detail screens. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-4 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export default async function DriverProfilePage({
  params,
}: {
  params: Promise<{ driverId: string }>;
}) {
  const { driverId } = await params;

  const driver = await prisma.driver.findUnique({
    where: { id: driverId },
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      licenseNumber: true,
      licenseState: true,
      verificationStatus: true,
      verifiedAt: true,
      verifications: {
        orderBy: { createdAt: "desc" },
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
        },
      },
    },
  });

  if (!driver) notFound();

  const [latest, ...history] = driver.verifications;
  const view = latest ? toVerificationView(latest) : null;
  const phase = latest ? verificationPhase(latest.status, latest.decision) : null;

  const consentHref = `/jumio-dashboard/drivers/${driver.id}/consent`;

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10">
      <div className="mb-6">
        <Link
          href="/jumio-dashboard"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← Jumio Dashboard
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{driver.name}</h1>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Driver</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y">
            <Field label="Phone">{formatText(driver.phone)}</Field>
            <Field label="Email">{formatText(driver.email)}</Field>
            <Field label="License on file">
              {driver.licenseNumber
                ? `${driver.licenseNumber}${driver.licenseState ? ` (${driver.licenseState})` : ""}`
                : "—"}
            </Field>
            <Field label="FreightID status">{humanizeEnum(driver.verificationStatus)}</Field>
            <Field label="Verified at">{formatDateTime(driver.verifiedAt)}</Field>
          </dl>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Identity Verification</CardTitle>
        </CardHeader>
        <CardContent>
          {!view || !phase ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                This driver has not been through identity verification yet.
              </p>
              <Button render={<Link href={consentHref} />}>Verify identity</Button>
            </div>
          ) : (
            <div className="space-y-4">
              {phase === "pending" && (
                <p className="text-sm text-muted-foreground">
                  Verification in progress — waiting for the result from Jumio. This page updates
                  when the callback arrives.
                </p>
              )}

              <dl className="divide-y">
                <Field label="Status">
                  <VerificationStatusBadge status={latest.status} />
                </Field>
                <Field label="Decision">
                  <VerificationDecisionBadge decision={latest.decision} />
                </Field>
                <Field label="Risk score">
                  <RiskScore score={view.riskScore} />
                </Field>

                {phase !== "pending" && (
                  <>
                    <Field label="Document">
                      {view.document.type ? humanizeEnum(view.document.type) : "—"}
                    </Field>
                    <Field label="Name">
                      {formatText(
                        [view.document.firstName, view.document.lastName]
                          .filter(Boolean)
                          .join(" ") || null,
                      )}
                    </Field>
                    <Field label="Date of birth">
                      {view.dateOfBirth ? formatDate(new Date(`${view.dateOfBirth}T00:00:00Z`)) : "—"}
                    </Field>
                    <Field label="License number">{formatText(view.licenseNumber)}</Field>
                    <Field label="Expiry">
                      {view.document.expiryDate
                        ? formatDate(new Date(`${view.document.expiryDate}T00:00:00Z`))
                        : "—"}
                    </Field>
                    <Field label="Issuing state">
                      {formatText(view.document.issuingState ?? view.document.issuingCountry)}
                    </Field>
                    <Field label="Face match">
                      <CapabilityBadge label={view.faceMatch} />
                    </Field>
                    <Field label="Liveness">
                      <CapabilityBadge label={view.liveness} />
                    </Field>
                  </>
                )}

                {view.error && (
                  <Field label="Last error">
                    <span className="text-destructive">{view.error}</span>
                  </Field>
                )}
              </dl>

              {phase !== "pending" && (
                <Button render={<Link href={consentHref} />} variant={phase === "passed" ? "outline" : "default"}>
                  {phase === "passed" ? "Verify again" : "Try again"}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {history.length > 0 && (
        <Card className="overflow-hidden p-0">
          <CardHeader className="px-(--card-spacing) pt-(--card-spacing)">
            <CardTitle>Earlier attempts</CardTitle>
          </CardHeader>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Decision</TableHead>
                  <TableHead className="text-right">Risk</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((attempt) => (
                  <TableRow key={attempt.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDateTime(attempt.startedAt)}
                    </TableCell>
                    <TableCell>
                      <VerificationStatusBadge status={attempt.status} />
                    </TableCell>
                    <TableCell>
                      <VerificationDecisionBadge decision={attempt.decision} />
                    </TableCell>
                    <TableCell className="text-right">
                      <RiskScore score={attempt.riskScore} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </main>
  );
}
