"use server";

import { revalidatePath } from "next/cache";

import { requireSession } from "@/lib/auth/guard";
import { createStaff, type FieldErrors, type StaffDraft } from "@/lib/tai/staff-create";

/**
 * Only `async function` exports are allowed beside `"use server"` — a type is
 * erased and so permitted, but a value is not. The matching `EMPTY_STATE` lives
 * in the form for that reason.
 */
export type CreateStaffState = {
  error: string | null;
  fieldErrors: FieldErrors;
  created: { staffId: number | null; name: string } | null;
};

function text(formData: FormData, name: string): string {
  return String(formData.get(name) ?? "");
}

export async function createStaffAction(formData: FormData): Promise<CreateStaffState> {
  await requireSession();

  const draft: StaffDraft = {
    contactName: text(formData, "contactName"),
    login: text(formData, "login"),
    password: text(formData, "password"),
    confirmPassword: text(formData, "confirmPassword"),
    email: text(formData, "email"),
    title: text(formData, "title"),
    organizationId: text(formData, "organizationId"),
    referenceNumber: text(formData, "referenceNumber"),
    // The form's Status select carries "Active"/"Inactive"; anything else is a
    // hand-crafted request, and inactive is the safer reading of one.
    enabled: text(formData, "status") === "Active",
    phone: text(formData, "phone"),
    mobile: text(formData, "mobile"),
    fax: text(formData, "fax"),
    streetAddress: text(formData, "streetAddress"),
    streetAddressTwo: text(formData, "streetAddressTwo"),
    city: text(formData, "city"),
    state: text(formData, "state"),
    zipCode: text(formData, "zipCode"),
    country: text(formData, "country"),
    permissions: formData.getAll("permissions").map(String),
  };

  const result = await createStaff(draft);

  if (!result.ok) {
    return { error: result.error, fieldErrors: result.fieldErrors, created: null };
  }

  // The roster page reads TAI live, but it is cached as a route — without this
  // the new person would be missing from the table they are sent back to.
  revalidatePath("/tai/staff");

  return {
    error: null,
    fieldErrors: {},
    created: { staffId: result.staffId, name: result.name },
  };
}
