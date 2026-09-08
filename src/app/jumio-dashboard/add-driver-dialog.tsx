"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { createDriverAction } from "./driver-actions";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Add a driver without going through a shipment.
 *
 * Only the name is required. Everything else is what FreightID happens to know
 * already — and deliberately not what Jumio will extract from the document,
 * which is the point of running the check.
 */
export function AddDriverDialog({ label = "Add driver" }: { label?: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);

  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setError(null);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button size="sm">{label}</Button>} />

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add driver</DialogTitle>
          <DialogDescription>
            Creates a driver record so identity verification can be started for them.
          </DialogDescription>
        </DialogHeader>

        <form
          ref={formRef}
          action={(formData) => {
            startTransition(async () => {
              const result = await createDriverAction(formData);

              if (result.error) {
                setError(result.error);
                return;
              }

              formRef.current?.reset();
              setOpen(false);
              setError(null);

              // Straight to the new driver's profile — the next thing anyone
              // wants after adding one is to start their verification.
              if (result.driverId) {
                router.push(`/jumio-dashboard/drivers/${result.driverId}`);
              } else {
                router.refresh();
              }
            });
          }}
          className="space-y-4"
        >
          <div className="space-y-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" required maxLength={120} autoComplete="off" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="phone">Phone</Label>
              <Input id="phone" name="phone" type="tel" autoComplete="off" />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" autoComplete="off" />
            </div>
          </div>

          <div className="grid grid-cols-[1fr_5rem] gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="licenseNumber">License number</Label>
              <Input id="licenseNumber" name="licenseNumber" autoComplete="off" />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="licenseState">State</Label>
              <Input id="licenseState" name="licenseState" maxLength={2} autoComplete="off" />
            </div>
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Adding…" : "Add driver"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
