"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { safeRedirectPath } from "@/lib/auth/redirect";
import { createClient } from "@/lib/supabase/browser";

/**
 * "Sign in with Google" — the only OAuth provider wired (Apple is post-MVP).
 *
 * Kicks off the Supabase Google OAuth redirect. `redirectTo` points at our
 * callback route and carries the validated post-login `next` so the user lands
 * where they intended. The `next` is sanitized with `safeRedirectPath` before
 * it is ever placed on a URL (open-redirect defense).
 */
export function GoogleSignInButton({ next }: { next?: string }) {
  const [pending, setPending] = React.useState(false);

  async function signIn() {
    setPending(true);
    const supabase = createClient();
    const safeNext = safeRedirectPath(next);
    const callback = new URL("/auth/callback", window.location.origin);
    callback.searchParams.set("next", safeNext);

    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: callback.toString() },
    });

    if (error) {
      setPending(false);
      window.location.assign("/login?error=oauth");
    }
    // On success the browser is redirected to Google; nothing more to do.
  }

  return (
    <Button onClick={signIn} disabled={pending} size="lg">
      {pending ? "Redirecting…" : "Sign in with Google"}
    </Button>
  );
}
