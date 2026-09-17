import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatText } from "@/lib/format";
import { listBrokerStaff, type StaffMember } from "@/lib/tai/staff";

// The roster lives in TAI, not in our database — there is nothing here to cache
// that would not immediately be a second, staler copy of it.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Staff · FreightID",
  description: "Broker staff from TAI.",
};

function PageShell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto w-full max-w-7xl px-6 py-10">{children}</main>;
}

/** Title above the table. Moving between the POC's halves is the nav's job. */
function PageHeader({ count }: { count: number | null }) {
  return (
    <header className="mb-6 flex flex-wrap items-baseline justify-between gap-2">
      <h1 className="text-2xl font-semibold tracking-tight">Staff</h1>

      {count === null ? null : (
        <p className="text-sm text-muted-foreground">
          {count} {count === 1 ? "person" : "people"}
        </p>
      )}
    </header>
  );
}

/**
 * An account TAI did not say either way about is left unjudged: `enabled` is
 * optional in the spec, and a missing flag is not a disabled account.
 */
function EnabledBadge({ enabled }: { enabled: boolean | null }) {
  if (enabled === null) {
    return <span className="text-muted-foreground">—</span>;
  }

  return (
    <Badge variant={enabled ? "secondary" : "outline"}>{enabled ? "Enabled" : "Disabled"}</Badge>
  );
}

/** Contact details are worth clicking, so the two that can be links are links. */
function ContactCell({ value, href }: { value: string | null; href: string | null }) {
  if (!value) return <span className="text-muted-foreground">—</span>;
  if (!href) return <>{value}</>;

  return (
    <a href={href} className="underline-offset-4 hover:underline">
      {value}
    </a>
  );
}

function StaffRow({ member }: { member: StaffMember }) {
  return (
    <TableRow>
      <TableCell className="font-medium tabular-nums">{member.staffId}</TableCell>

      <TableCell className="max-w-[14rem] truncate" title={member.name}>
        {member.name}
      </TableCell>

      <TableCell className="max-w-[12rem] truncate" title={member.title ?? ""}>
        {formatText(member.title)}
      </TableCell>

      <TableCell className="max-w-[16rem] truncate" title={member.email ?? ""}>
        <ContactCell value={member.email} href={member.email ? `mailto:${member.email}` : null} />
      </TableCell>

      <TableCell className="max-w-[10rem] truncate" title={member.login ?? ""}>
        {formatText(member.login)}
      </TableCell>

      <TableCell className="whitespace-nowrap tabular-nums">
        <ContactCell value={member.phone} href={member.phone ? `tel:${member.phone}` : null} />
      </TableCell>

      <TableCell className="whitespace-nowrap">{formatText(member.location)}</TableCell>

      <TableCell className="tabular-nums text-muted-foreground">
        {member.organizationId ?? "—"}
      </TableCell>

      <TableCell>
        <EnabledBadge enabled={member.enabled} />
      </TableCell>
    </TableRow>
  );
}

export default async function StaffPage() {
  const { staff, error } = await listBrokerStaff();

  // A failed read and an empty roster are different facts, so they are not
  // collapsed into one "nothing here" card.
  if (error) {
    return (
      <PageShell>
        <PageHeader count={null} />
        <Card>
          <CardHeader>
            <CardTitle>Staff unavailable</CardTitle>
            <CardDescription>
              {error} The attempt is recorded in the TAI call log; reload to try again.
            </CardDescription>
          </CardHeader>
        </Card>
      </PageShell>
    );
  }

  if (staff.length === 0) {
    return (
      <PageShell>
        <PageHeader count={0} />
        <Card>
          <CardHeader>
            <CardTitle>No staff</CardTitle>
            <CardDescription>
              TAI returned no broker staff for this API key&apos;s organization.
            </CardDescription>
          </CardHeader>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader count={staff.length} />

      <Card className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Staff ID</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Login</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Location</TableHead>
                <TableHead>Org ID</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {staff.map((member) => (
                <StaffRow key={member.staffId} member={member} />
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>
    </PageShell>
  );
}
