"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
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

/** The dataset omits what it has no value for, so a gap here is normal. */
const EMPTY = "—";

const DATE = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "2-digit",
});

/**
 * The dates arrive as `YYYYMMDD` with no zone and mean a calendar day, so they
 * are read as UTC — parsed locally, a filing dated the 1st reads as the 31st
 * anywhere west of Greenwich.
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

/** "BI&PD (1) · Primary (P)" — the label never replaces the filed code. */
function describeCode(label: string | null, code: string | null): string {
  if (!code) return label ?? EMPTY;
  return label ? `${label} (${code})` : code;
}

function PolicyRow({ policy }: { policy: FmcsaInsurancePolicy }) {
  return (
    <TableRow>
      <TableCell className="align-top">
        <div className="flex items-center gap-2">
          <span>{describeCode(policy.typeLabel, policy.typeCode)}</span>
          {policy.isLatestForCoverage && (
            <Badge variant="secondary" title="Newest filing for this coverage type and class">
              Latest
            </Badge>
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {describeCode(policy.classLabel, policy.classCode)}
        </div>
      </TableCell>

      <TableCell className="align-top whitespace-normal">
        <div>{policy.insuranceCompanyName ?? EMPTY}</div>
        <div className="text-xs text-muted-foreground">
          {describeCode(policy.formLabel, policy.formCode)}
        </div>
      </TableCell>

      <TableCell className="align-top">{policy.policyNumber ?? EMPTY}</TableCell>
      <TableCell className="align-top tabular-nums">
        {formatAmount(policy.maxCoverageAmount)}
      </TableCell>
      <TableCell className="align-top tabular-nums">
        {formatAmount(policy.underlyingLimitAmount)}
      </TableCell>
      <TableCell className="align-top">{formatDate(policy.effectiveDate)}</TableCell>
      <TableCell className="align-top">{formatDate(policy.filedDate)}</TableCell>
      <TableCell className="align-top">{policy.docketNumber ?? EMPTY}</TableCell>
    </TableRow>
  );
}

export function InsuranceResult({ result }: { result: FmcsaInsuranceResult }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Insurance filings</CardTitle>
        <CardDescription>
          From the FMCSA <span className="font-mono text-xs">Motus Insur — All With History</span>{" "}
          dataset on data.transportation.gov.
        </CardDescription>
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
                  <TableHead>Insurer / form</TableHead>
                  <TableHead>Policy no.</TableHead>
                  <TableHead>Max coverage</TableHead>
                  <TableHead>Underlying limit</TableHead>
                  <TableHead>Effective</TableHead>
                  <TableHead>Filed</TableHead>
                  <TableHead>Docket</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.policies.map((policy, index) => (
                  <PolicyRow
                    // Nothing in the dataset is unique per filing — a carrier can
                    // file the same policy number twice under different forms —
                    // so position in the sorted list is the only stable key.
                    key={index}
                    policy={policy}
                  />
                ))}
              </TableBody>
            </Table>

            {/*
              The dataset holds active and pending filings with no cancellation
              date, so "Latest" is what the columns support and not a statement
              that the policy is in force. Saying so here keeps the badge from
              being read as a coverage confirmation.
            */}
            <p className="text-xs text-muted-foreground">
              <strong className="font-medium">Latest</strong> marks the newest filing for each
              coverage type and class. The dataset carries active and pending filings with no
              cancellation date, so it does not confirm coverage is in force today — verify a
              certificate before relying on it.
            </p>

            <Accordion>
              <AccordionItem value="raw-insurance">
                <AccordionTrigger>
                  Raw response ({result.raw.length} of {result.rowCount} rows, duplicates removed)
                </AccordionTrigger>
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
