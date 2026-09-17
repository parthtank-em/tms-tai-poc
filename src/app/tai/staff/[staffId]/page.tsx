import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatText } from "@/lib/format";
import { ORGANIZATION_ID, ORGANIZATION_NAME } from "@/lib/tai/organization";
import { getStaffMember, type StaffDetail } from "@/lib/tai/staff";
import { symbolLabel } from "@/lib/tai/staff-fields";

// Read live from TAI on every request, like the roster it came from.
export const dynamic = "force-dynamic";

/** Label/value row, matching the shipment detail page's summary cards. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-4 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

/** A value worth clicking — an email or a phone number — rendered as a link. */
function ContactValue({ value, href }: { value: string | null; href: string | null }) {
  if (!value) return <>—</>;
  if (!href) return <>{value}</>;

  return (
    <a href={href} className="underline-offset-4 hover:underline">
      {value}
    </a>
  );
}

/**
 * A list of enum values as badges.
 *
 * TAI omits these arrays entirely when empty rather than sending `[]`, so an
 * absent list and a deliberately empty one look identical here. The card says
 * "None" for both rather than implying it knows which.
 */
function BadgeList({ values }: { values: string[] }) {
  if (values.length === 0) {
    return <p className="text-sm text-muted-foreground">None</p>;
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <Badge key={value} variant="outline" className="font-normal">
          {symbolLabel(value)}
        </Badge>
      ))}
    </div>
  );
}

/**
 * The address, one row per key.
 *
 * Not rendered as a postal block: joining city and state onto one line, or
 * dropping the empty parts, would hide which of the seven fields TAI actually
 * holds — and those are the same seven the create form writes.
 */
function AddressFields({ address }: { address: StaffDetail["address"] }) {
  return (
    <dl className="divide-y">
      <Field label="Street address">{formatText(address.streetAddress)}</Field>
      <Field label="Street address 2">{formatText(address.streetAddressTwo)}</Field>
      <Field label="City">{formatText(address.city)}</Field>
      <Field label="State">{formatText(address.state)}</Field>
      <Field label="ZIP">{formatText(address.zipCode)}</Field>
      <Field label="Country">{formatText(address.country)}</Field>
      <Field label="Contact name">{formatText(address.contactName)}</Field>
    </dl>
  );
}

export default async function StaffDetailPage({
  params,
}: {
  params: Promise<{ staffId: string }>;
}) {
  const { staffId } = await params;
  const { staff, error } = await getStaffMember(Number(staffId));

  // A failed read and a person who does not exist are different facts. Only the
  // second is a 404; the first says so and offers the way back.
  if (error) {
    return (
      <main className="mx-auto w-full max-w-4xl px-6 py-10">
        <Link
          href="/tai/staff"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← Staff
        </Link>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Staff member unavailable</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      </main>
    );
  }

  if (!staff) {
    notFound();
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10">
      <Link
        href="/tai/staff"
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        ← Staff
      </Link>

      <header className="mt-4 mb-8">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">{staff.headingName}</h1>

          {staff.enabled === null ? (
            <Badge variant="outline">Status unknown</Badge>
          ) : (
            <Badge variant={staff.enabled ? "secondary" : "outline"}>
              {staff.enabled ? "Enabled" : "Disabled"}
            </Badge>
          )}
        </div>

        <p className="mt-1 text-sm text-muted-foreground tabular-nums">Staff #{staff.staffId}</p>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
          </CardHeader>
          <CardContent>
            {/* No Staff ID row: TAI assigns it rather than the form sending it,
                and the subtitle above already carries it. */}
            <dl className="divide-y">
              <Field label="Login">{formatText(staff.login)}</Field>
              <Field label="Contact name">{formatText(staff.contactName)}</Field>
              <Field label="Title">{formatText(staff.title)}</Field>
              <Field label="Reference number">{formatText(staff.referenceNumber)}</Field>
              {/* Two rows, not one. The id is TAI's; the name is ours, shown
                  only when the id is the one it belongs to. */}
              <Field label="Organization">
                {staff.organizationId === ORGANIZATION_ID ? ORGANIZATION_NAME : "—"}
              </Field>
              <Field label="Organization ID">
                <span className="tabular-nums">{staff.organizationId ?? "—"}</span>
              </Field>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Contact</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              <Field label="Email">
                <ContactValue
                  value={staff.email}
                  href={staff.email ? `mailto:${staff.email}` : null}
                />
              </Field>
              <Field label="Phone">
                <ContactValue
                  value={staff.phone}
                  href={staff.phone ? `tel:${staff.phone}` : null}
                />
              </Field>
              <Field label="Mobile">
                <ContactValue
                  value={staff.mobile}
                  href={staff.mobile ? `tel:${staff.mobile}` : null}
                />
              </Field>
              <Field label="Fax">{formatText(staff.fax)}</Field>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Address</CardTitle>
          </CardHeader>
          <CardContent>
            <AddressFields address={staff.address} />
          </CardContent>
        </Card>

        {/* Sits in the slot beside Address rather than spanning the row, so the
            four cards read as a 2×2 and no gap opens up next to Address.

            This page mirrors the create form, so it shows only what that form
            sends. TAI also returns notification flags, default shipment types,
            staff settings and tariff settings; none are set here, so showing
            them would invite edits this POC cannot make. */}
        <Card>
          <CardHeader>
            <CardTitle>Permissions</CardTitle>
          </CardHeader>
          <CardContent>
            <BadgeList values={staff.permissions} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
