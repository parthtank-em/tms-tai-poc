import { EyeIcon } from "lucide-react";
import Link from "next/link";

import { AddDriverDialog } from "./add-driver-dialog";

import { PickupVerificationDialog } from "@/components/jumio/pickup-verification-dialog";
import { VerificationDecisionBadge, VerificationStatusBadge } from "@/components/jumio/verification-badges";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, formatText } from "@/lib/format";
import { isJumioConfigured, isJumioPickupConfigured } from "@/lib/jumio/config";
import { prisma } from "@/lib/prisma";

import type { JumioVerificationStatus } from "@/generated/prisma/enums";

// Verification state changes whenever a Jumio callback lands, so this is always
// read fresh rather than served from a cached render.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Jumio Dashboard · FreightID",
  description: "Driver identity verification.",
};

/** Tile order, worst first: the counts an operator has to act on lead. */
const TILES: { key: string; label: string; hint: string; match: (s: JumioVerificationStatus, d: string | null) => boolean }[] = [
  {
    key: "rejected",
    label: "Not passed",
    hint: "Rejected or flagged by Jumio",
    match: (s, d) => s === "PROCESSED" && d !== "PASSED",
  },
  {
    key: "expired",
    label: "Expired / failed",
    hint: "Session ran out or never started",
    match: (s) => s === "SESSION_EXPIRED" || s === "TOKEN_EXPIRED" || s === "FAILED",
  },
  {
    key: "pending",
    label: "In progress",
    hint: "Awaiting the Jumio result",
    match: (s) => s === "INITIATED" || s === "ACQUISITION_STARTED" || s === "ACQUIRED" || s === "PROCESSING",
  },
  {
    key: "passed",
    label: "Passed",
    hint: "Identity confirmed",
    match: (s, d) => s === "PROCESSED" && d === "PASSED",
  },
];

export default async function JumioDashboardPage() {
  const drivers = await prisma.driver.findMany({
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      licenseState: true,
      verificationStatus: true,
      verifications: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          status: true,
          decision: true,
          riskScore: true,
          startedAt: true,
          completedAt: true,
        },
      },
    },
  });

  // Counted in memory rather than with a groupBy: the same rows are already
  // being read for the table below, and a second round trip could disagree with
  // it if a callback lands between the two queries.
  const counts = new Map<string, number>();
  for (const driver of drivers) {
    const latest = driver.verifications[0];
    if (!latest) continue;

    const tile = TILES.find((candidate) => candidate.match(latest.status, latest.decision));
    if (tile) counts.set(tile.key, (counts.get(tile.key) ?? 0) + 1);
  }

  const configured = isJumioConfigured();

  // Only a driver whose registration actually passed has a facemap to compare a
  // pickup selfie against.
  const pickupDrivers = drivers
    // .filter((driver) => driver.verificationStatus === "VERIFIED")
    .map((driver) => ({ id: driver.id, name: driver.name }));

  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-10">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Jumio Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Government ID, selfie and liveness verification for drivers.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <p className="text-sm text-muted-foreground">
            {drivers.length} {drivers.length === 1 ? "driver" : "drivers"}
          </p>
          {/* The document-check screen is still reachable at
              /jumio-dashboard/documents — it is just not advertised here, since
              identity verification is the only flow in scope for now. */}
          {isJumioPickupConfigured() && <PickupVerificationDialog drivers={pickupDrivers} />}
          <AddDriverDialog />
        </div>
      </header>

      {!configured && (
        <Card className="mb-6 border-l-2 border-l-destructive">
          <CardHeader>
            <CardTitle>Jumio is not configured</CardTitle>
            <CardDescription>
              Verification cannot be started until the Jumio credentials are set. See the
              <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">JUMIO_*</code>
              entries in <code className="rounded bg-muted px-1 py-0.5 text-xs">.env.example</code>.
              The specific missing variable is named in the server log.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {TILES.map((tile) => (
          <Card key={tile.key}>
            <CardHeader>
              <CardDescription>{tile.label}</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{counts.get(tile.key) ?? 0}</CardTitle>
              <CardDescription className="text-xs">{tile.hint}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>

      {drivers.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No drivers yet</CardTitle>
            <CardDescription>
              Add a driver to start an identity verification for them. Nothing here depends on a
              shipment existing.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AddDriverDialog label="Add your first driver" />
          </CardContent>
        </Card>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Driver</TableHead>
                  <TableHead>Verification</TableHead>
                  <TableHead>Decision</TableHead>
                  <TableHead className="text-right">Risk</TableHead>
                  <TableHead>Last attempt</TableHead>
                  <TableHead className="w-10 text-right">
                    <span className="sr-only">View</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {drivers.map((driver) => {
                  const latest = driver.verifications[0];
                  const href = `/jumio-dashboard/drivers/${driver.id}`;

                  return (
                    <TableRow key={driver.id}>
                      <TableCell className="max-w-[18rem] truncate" title={driver.name}>
                        <Link href={href} className="font-medium underline-offset-4 hover:underline">
                          {formatText(driver.name)}
                        </Link>
                      </TableCell>

                      <TableCell>
                        {latest ? (
                          <VerificationStatusBadge status={latest.status} />
                        ) : (
                          <span className="text-muted-foreground">Never verified</span>
                        )}
                      </TableCell>

                      <TableCell>
                        <VerificationDecisionBadge decision={latest?.decision ?? null} />
                      </TableCell>

                      <TableCell className="text-right tabular-nums">
                        {latest?.riskScore ?? <span className="text-muted-foreground">—</span>}
                      </TableCell>

                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {latest ? formatDateTime(latest.completedAt ?? latest.startedAt) : "—"}
                      </TableCell>

                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`View ${driver.name}`}
                          render={<Link href={href} />}
                        >
                          <EyeIcon />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </Card>
      )}
    </main>
  );
}
