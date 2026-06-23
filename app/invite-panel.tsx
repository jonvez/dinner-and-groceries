"use client";

/**
 * Owner-only invite generator (issue #6, criterion 2). Rendered on the home
 * screen for owners. Minting + the share URL come from `generateInviteAction`;
 * owner-gating is RLS-enforced server-side (a non-owner's insert is denied), so
 * this UI is a convenience, not the security boundary.
 */

import { useActionState } from "react";

import { generateInviteAction, type InviteState } from "./join/actions";

function isInvite(state: InviteState): state is { url: string; expiresAt: string | null } {
  return state !== null && "url" in state;
}

export function InvitePanel() {
  const [state, action, pending] = useActionState<InviteState, FormData>(
    generateInviteAction,
    null,
  );

  return (
    <section className="border-border w-full max-w-md space-y-3 rounded-lg border p-4 text-left">
      <h2 className="text-lg font-medium">Invite your family</h2>
      <p className="text-muted-foreground text-sm">
        Generate a single-use link that expires in 7 days.
      </p>

      <form action={action}>
        <button
          type="submit"
          disabled={pending}
          className="bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60"
        >
          {pending ? "Generating…" : "Create invite link"}
        </button>
      </form>

      {isInvite(state) ? (
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor="invite-url">
            Share this link
          </label>
          <input
            id="invite-url"
            readOnly
            value={state.url}
            onFocus={(e) => e.currentTarget.select()}
            className="border-input bg-muted w-full rounded-md border px-3 py-2 font-mono text-xs"
          />
        </div>
      ) : null}

      {state !== null && "error" in state ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}
    </section>
  );
}
