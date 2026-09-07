"use client";

import { useActionState, useState } from "react";

import { loginAction, type LoginState } from "./actions";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const INITIAL: LoginState = { error: null };

export function LoginForm({ returnTo }: { returnTo: string }) {
  const [state, formAction, pending] = useActionState(loginAction, INITIAL);

  // React resets the form once the action settles, which would wipe the
  // username along with the password. Holding it in state keeps a failed
  // attempt from making the operator retype both fields.
  const [username, setUsername] = useState("");

  const invalid = state.error !== null;

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="from" value={returnTo} />

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="username">Username</Label>
          <Input
            id="username"
            name="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
            autoFocus
            disabled={pending}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? "login-error" : undefined}
            className="h-9"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            disabled={pending}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? "login-error" : undefined}
            className="h-9"
          />
        </div>
      </div>

      {/* Reserve the row whether or not it is filled, so the button does not
          jump down when a failed attempt appears. */}
      <p
        id="login-error"
        role="alert"
        aria-live="polite"
        className="min-h-4 text-xs text-destructive"
      >
        {state.error}
      </p>

      {/* size="lg" is h-9 — the same height as the inputs above it. */}
      <Button type="submit" size="lg" disabled={pending} className="w-full">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}
