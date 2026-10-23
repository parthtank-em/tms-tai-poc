"use client";

import { LoaderCircleIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { deleteSessionAction } from "../actions";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/** Deletes a planned session after a confirmation, then goes back to the list. */
export function DeleteSessionButton({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function confirm() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await deleteSessionAction(sessionId);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setOpen(false);
        router.push("/tracking");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Deleting failed.");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" />}>
        <Trash2Icon />
        Delete
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this trip?</DialogTitle>
          <DialogDescription>
            It disappears from the portal and from the mobile app&apos;s trip list. Its geofences
            are only created when a phone starts it, so nothing needs cleaning up in Radar.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter>
          <DialogClose render={<Button variant="outline" />} disabled={pending}>
            Cancel
          </DialogClose>
          <Button variant="destructive" onClick={confirm} disabled={pending}>
            {pending ? <LoaderCircleIcon className="animate-spin" /> : <Trash2Icon />}
            Delete trip
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
