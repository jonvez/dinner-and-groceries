"use client";

/**
 * Client forms for the "join your family" screen (issue #6, criterion 5).
 *
 * A signed-in user with no household sees this — never a broken empty app. Two
 * paths: CREATE a new household, or ACCEPT an invite via a code. Both use
 * `useActionState` to surface inline server-action errors. Submission identity
 * is resolved server-side from the session (never trusted from these inputs).
 */

import { useActionState } from "react";

import { acceptInviteAction, createHouseholdAction } from "./actions";

export function CreateHouseholdForm() {
  const [state, action, pending] = useActionState(createHouseholdAction, null);

  return (
    <form action={action} className="flex w-full flex-col gap-3 text-left">
      <label className="text-sm font-medium" htmlFor="ch-name">
        Household name
      </label>
      <input
        id="ch-name"
        name="name"
        required
        maxLength={120}
        placeholder="The Gill Family"
        className="border-input bg-background rounded-md border px-3 py-2 text-sm"
      />

      <label className="text-sm font-medium" htmlFor="ch-display">
        Your name
      </label>
      <input
        id="ch-display"
        name="displayName"
        required
        maxLength={80}
        placeholder="Jon"
        className="border-input bg-background rounded-md border px-3 py-2 text-sm"
      />

      {state?.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60"
      >
        {pending ? "Creating…" : "Create household"}
      </button>
    </form>
  );
}

export function AcceptInviteForm({ token = "" }: { token?: string }) {
  const [state, action, pending] = useActionState(acceptInviteAction, null);

  return (
    <form action={action} className="flex w-full flex-col gap-3 text-left">
      <label className="text-sm font-medium" htmlFor="ai-token">
        Invite code
      </label>
      <input
        id="ai-token"
        name="token"
        required
        defaultValue={token}
        placeholder="Paste your invite code"
        className="border-input bg-background rounded-md border px-3 py-2 font-mono text-sm"
      />

      <label className="text-sm font-medium" htmlFor="ai-display">
        Your name
      </label>
      <input
        id="ai-display"
        name="displayName"
        required
        maxLength={80}
        placeholder="Alex"
        className="border-input bg-background rounded-md border px-3 py-2 text-sm"
      />

      {state?.error ? (
        <p role="alert" className="text-destructive text-sm">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60"
      >
        {pending ? "Joining…" : "Join household"}
      </button>
    </form>
  );
}
