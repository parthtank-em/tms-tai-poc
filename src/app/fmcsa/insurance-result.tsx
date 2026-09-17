"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { FmcsaInsurancePolicy, FmcsaInsuranceResult } from "@/lib/fmcsa/insurance";

const EMPTY = "—";

const DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "2-digit",
});

/**
 * The dates mean a calendar day and carry no zone, so they are read as UTC —
 * parsed locally, a filing dated the 1st reads as the 31st west of Greenwich.
 */
function formatDate(iso: string | null): string {
  if (!iso) return EMPTY;

  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? iso : DATE.format(parsed);
}

/** Groups the digits by string surgery so a limit is never rounded by a float. */
function formatAmount(value: string | null): string {
  if (value === null) return EMPTY;

  const [whole, fraction] = value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  return `$${fraction ? `${grouped}.${fraction}` : grouped}`;
}

/**
 * Self-insured filings carry "0" or "NONE" where a policy number goes. Both are
 * placeholders for "there isn't one", and printing them reads as a real policy
 * numbered zero.
 */
function formatPolicyNumber(value: string | null): string {
  if (!value || value === "0" || value.toUpperCase() === "NONE") return EMPTY;
  return value;
}

/**
 * "BI&PD" or "BI&PD · Excess".
 *
 * Primary is the ordinary case and adding it to every row says nothing, so only
 * a non-primary class is named. The filed codes are dropped from the table
 * entirely — they duplicate the label beside them, and the raw panel has them
 * for anyone checking a mapping.
 */
function describeCoverage(policy: FmcsaInsurancePolicy): string {
  const type = policy.typeLabel ?? policy.typeCode ?? EMPTY;
  const isPrimary = policy.classCode?.toUpperCase() === "P";

  return !isPrimary && policy.classLabel ? `${type} · ${policy.classLabel}` : type;
}

export function InsuranceResult({ result }: { result: FmcsaInsuranceResult }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Insurance filings</CardTitle>
        <CardDescription>From FMCSA&rsquo;s insurance filing records.</CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {!result.ok ? (
          <p role="alert" className="text-sm text-destructive">
            {result.message}
          </p>
        ) : result.policies.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No insurance filings on record for this USDOT number.
          </p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Coverage</TableHead>
                  <TableHead>Insurer</TableHead>
                  <TableHead>Policy no.</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Effective</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.policies.map((policy, index) => (
                  <TableRow
                    // Nothing in the dataset is unique per filing — a carrier can
                    // file the same policy number twice under different forms —
                    // so position in the sorted list is the only stable key.
                    key={index}
                  >
                    <TableCell>{describeCoverage(policy)}</TableCell>
                    <TableCell className="whitespace-normal">
                      {policy.insuranceCompanyName ?? EMPTY}
                    </TableCell>
                    <TableCell>{formatPolicyNumber(policy.policyNumber)}</TableCell>
                    <TableCell className="tabular-nums">
                      {formatAmount(policy.maxCoverageAmount)}
                    </TableCell>
                    <TableCell>{formatDate(policy.effectiveDate)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <Accordion>
              <AccordionItem value="raw-insurance">
                <AccordionTrigger>Raw response ({result.rowCount} rows)</AccordionTrigger>
                <AccordionContent>
                  <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 text-xs">
                    {JSON.stringify(result.raw, null, 2)}
                  </pre>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </>
        )}
      </CardContent>
    </Card>
  );
}
