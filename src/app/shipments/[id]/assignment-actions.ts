"use server";

import { requireSession } from "@/lib/auth/guard";
import { assignStaff } from "@/lib/tai/assignments";
import { loadBrokerStaff, type StaffOption } from "@/lib/tai/staff";

export type StaffState = {
  options: StaffOption[];
  /** Set when TAI could not be reached and no cached roster exists. */
  error: string | null;
};

export type AssignmentState = {
  error: string | null;
  notice: string | null;
};

/** Staff for the dropdown, straight from TAI's Staff API. */
export async function fetchBrokerStaff(): Promise<StaffState> {
  await requireSession();
  return loadBrokerStaff();
}

export async function assignStaffAction(formData: FormData): Promise<AssignmentState> {
  await requireSession();

  const shipmentId = String(formData.get("shipmentId") ?? "");
  const rawStaffId = String(formData.get("staffId") ?? "").trim();
  const staffName = String(formData.get("staffName") ?? "").trim();

  const staffId = Number(rawStaffId);
  if (!rawStaffId || !Number.isInteger(staffId)) {
    return { error: "Select a staff member.", notice: null };
  }

  const result = await assignStaff(shipmentId, staffId);

  if (!result.ok) {
    return { error: result.error, notice: null };
  }

  // TAI has no endpoint to read assignments back, so this message is the only
  // evidence the operator gets. It names who, and the id TAI returned.
  const who = staffName || `staff #${staffId}`;
  return {
    error: null,
    notice: result.assignmentId
      ? `Assigned to ${who} (assignment #${result.assignmentId}).`
      : `Assigned to ${who}.`,
  };
}
