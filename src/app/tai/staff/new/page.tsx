import Link from "next/link";

import { StaffForm } from "./staff-form";

export default function NewStaffPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="mb-6">
        <Link
          href="/tai/staff"
          className="text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          ← Staff
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New staff member</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Creates the person in TAI. There is no local copy — the roster is theirs.
        </p>
      </div>

      <StaffForm />
    </main>
  );
}
