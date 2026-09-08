"use server";

import { revalidatePath } from "next/cache";

import { requireSession } from "@/lib/auth/guard";
import { prisma } from "@/lib/prisma";

/**
 * Creating a driver from the Jumio side.
 *
 * The TAI lifecycle also creates drivers, as a side effect of one being
 * assigned to a shipment. That is the wrong dependency for this integration:
 * identity verification should be demonstrable without a shipment existing at
 * all, so the Jumio dashboard can put a driver in the book itself.
 *
 * Both paths write the same `Driver` row on purpose. A driver is a driver — a
 * second, Jumio-only driver table would mean the same person verified here and
 * dispatched there, with no way to reconcile them.
 */

export type CreateDriverState = {
  error: string | null;
  driverId: string | null;
};

/** Long enough for a real name, short enough to keep a stray paste out of the column. */
const MAX_NAME = 120;

function optional(value: FormDataEntryValue | null, max = 100): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.slice(0, max);
}

export async function createDriverAction(formData: FormData): Promise<CreateDriverState> {
  await requireSession();

  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    return { error: "A driver name is required.", driverId: null };
  }

  if (name.length > MAX_NAME) {
    return { error: `Name must be ${MAX_NAME} characters or fewer.`, driverId: null };
  }

  // A licence state is two letters or nothing — a free-text state code would
  // show up later inside extracted-document comparisons.
  const licenseState = optional(formData.get("licenseState"), 2)?.toUpperCase() ?? null;

  const driver = await prisma.driver.create({
    data: {
      name,
      phone: optional(formData.get("phone"), 40),
      email: optional(formData.get("email")),
      licenseNumber: optional(formData.get("licenseNumber"), 40),
      licenseState,
      // Untouched by Jumio until a verification actually runs.
      verificationStatus: "UNVERIFIED",
    },
    select: { id: true },
  });

  revalidatePath("/jumio-dashboard");

  return { error: null, driverId: driver.id };
}
