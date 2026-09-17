"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { createStaffAction, type CreateStaffState } from "./actions";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TAI_COUNTRIES } from "@/lib/tai/countries";
// Everything here comes from `staff-fields`, which imports nothing: reaching
// into `api-client` or `staff-create` for the same constants would pull Prisma
// into the browser bundle.
import { TAI_STAFF_PERMISSIONS, symbolLabel } from "@/lib/tai/staff-fields";

/**
 * Lives here rather than beside the action: a server-action module may export
 * only async functions, and a plain object breaks the page at runtime.
 */
const EMPTY_STATE: CreateStaffState = { error: null, fieldErrors: {}, created: null };

/**
 * One labelled input, with the field error underneath.
 *
 * `aria-invalid` drives the red ring the Input already knows how to draw, so an
 * error is visible and announced without a second styling vocabulary.
 */
function Field({
  name,
  label,
  error,
  required,
  hint,
  children,
  ...props
}: React.ComponentProps<typeof Input> & {
  name: string;
  label: string;
  error?: string;
  hint?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>
        {label}
        {required ? <span className="ml-0.5 text-destructive">*</span> : null}
      </Label>

      {children ?? (
        <Input id={name} name={name} aria-invalid={error ? true : undefined} {...props} />
      )}

      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** A checkbox with its label, as a form value rather than React state. */
function CheckboxField({
  name,
  value,
  label,
  defaultChecked,
}: {
  name: string;
  value: string;
  label: string;
  defaultChecked?: boolean;
}) {
  const id = `${name}-${value}`;

  return (
    <div className="flex items-center gap-2">
      <Checkbox id={id} name={name} value={value} defaultChecked={defaultChecked} />
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
    </div>
  );
}

/**
 * A card of checkboxes sharing one field name, which is how the API's four
 * array fields arrive: `formData.getAll(name)` gives back exactly the selected
 * values.
 */
function CheckboxCard({
  title,
  name,
  options,
}: {
  title: string;
  name: string;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2">
          {options.map((option) => (
            <CheckboxField
              key={option.value}
              name={name}
              value={option.value}
              label={option.label}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

export function StaffForm() {
  const [state, setState] = useState<CreateStaffState>(EMPTY_STATE);
  const [pending, startTransition] = useTransition();

  // Both selects are controlled so their value can ride along in a hidden input
  // — Base UI's Select is not a native `<select>` the form can read.
  const [status, setStatus] = useState<string>("Active");
  const [country, setCountry] = useState<string>("USA");

  const errors = state.fieldErrors;

  if (state.created) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Staff member created</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {state.created.name} now exists in TAI
            {state.created.staffId ? ` as staff #${state.created.staffId}` : ""}.
          </p>

          <div className="flex gap-2">
            <Button render={<Link href="/tai/staff" />}>Back to staff</Button>
            <Button variant="outline" onClick={() => setState(EMPTY_STATE)}>
              Add another
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <form
      action={(formData) => {
        startTransition(async () => {
          try {
            setState(await createStaffAction(formData));
          } catch (cause) {
            setState({
              error: cause instanceof Error ? cause.message : "Something went wrong.",
              fieldErrors: {},
              created: null,
            });
          }
        });
      }}
      className="space-y-6"
    >
      {/* Base UI selects are not native inputs, so their values are carried in
          hidden fields the form can actually serialize. */}
      <input type="hidden" name="status" value={status} />
      <input type="hidden" name="country" value={country} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Staff information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field
              name="contactName"
              label="Name"
              required
              autoComplete="off"
              error={errors.contactName}
            />
            <Field name="login" label="Login" required autoComplete="off" error={errors.login} />
            <Field
              name="password"
              label="Password"
              type="password"
              required
              autoComplete="new-password"
              error={errors.password}
            />
            <Field
              name="confirmPassword"
              label="Confirm password"
              type="password"
              required
              autoComplete="new-password"
              error={errors.confirmPassword}
            />
            <Field name="title" label="Title" error={errors.title} />

            {/* A plain numeric field: TAI publishes no organizations endpoint,
                so there is no list to pick from — the id is typed. Non-digits
                are stripped as they arrive rather than rejected after the fact. */}
            <Field
              name="organizationId"
              label="Organization ID"
              required
              inputMode="numeric"
              autoComplete="off"
              placeholder="685263"
              error={errors.organizationId}
              onChange={(event) => {
                event.currentTarget.value = event.currentTarget.value.replace(/\D/g, "");
              }}
            />

            <Field
              name="referenceNumber"
              label="Reference number"
              error={errors.referenceNumber}
            />

            <Field name="status" label="Status">
              <Select value={status} onValueChange={(v) => setStatus(v as string)}>
                <SelectTrigger id="status" className="h-8 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Active">Active</SelectItem>
                  <SelectItem value="Inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Contact information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field
              name="email"
              label="Email"
              type="email"
              required
              autoComplete="off"
              error={errors.email}
            />

            {/* TAI takes one unformatted string per number — no country picker,
                because the `+` and country code are part of the value. */}
            <Field
              name="phone"
              label="Phone"
              placeholder="+15551234567"
              error={errors.phone}
              hint="Country code required. With an extension: +15551234567x89"
            />
            <Field name="mobile" label="Mobile" placeholder="+15551234567" error={errors.mobile} />
            <Field name="fax" label="Fax" placeholder="+15551234567" error={errors.fax} />

            <Field name="streetAddress" label="Street address" error={errors.streetAddress} />
            <Field
              name="streetAddressTwo"
              label="Street address 2"
              error={errors.streetAddressTwo}
            />

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="col-span-2 sm:col-span-1">
                <Field name="city" label="City" error={errors.city} />
              </div>
              <Field name="state" label="State" maxLength={2} error={errors.state} />
              <Field name="zipCode" label="ZIP" maxLength={7} error={errors.zipCode} />

              <div className="col-span-2 sm:col-span-1">
                <Field name="country" label="Country" error={errors.country}>
                  <Select value={country} onValueChange={(v) => setCountry(v as string)}>
                    <SelectTrigger id="country" className="h-8 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="max-h-72">
                      {TAI_COUNTRIES.map((name) => (
                        <SelectItem key={name} value={name}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* The only checkbox group on the form. The request schema also accepts
            notification flags, default shipment types, staff settings and
            tariff settings; none are collected here, so TAI applies its own
            defaults for them. */}
        <div className="lg:col-span-2">
          <CheckboxCard
            title="Permissions"
            name="permissions"
            options={TAI_STAFF_PERMISSIONS.map((value) => ({ value, label: symbolLabel(value) }))}
          />
        </div>
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        <Button type="submit" size="lg" disabled={pending}>
          {pending ? "Creating…" : "Create staff member"}
        </Button>
        <Button variant="outline" size="lg" render={<Link href="/tai/staff" />}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
