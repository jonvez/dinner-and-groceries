/**
 * Pure orchestration for the household-create / invite / join flows (issue #6).
 *
 * These functions take an injected Supabase-like client so they are unit-tested
 * WITHOUT a live DB or a Google round-trip (issue #6 "testing reality"). The
 * thin Server Actions (`actions.ts`) build the real cookie-session client, call
 * these, then redirect. The security-critical atomic/single-use/expiry logic
 * lives in the SECURITY DEFINER SQL functions (covered by pgTAP); here we only
 * validate input, dispatch, and translate errors into user-facing messages.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { mintInviteToken } from "@/lib/invites/token";

type DbClient = SupabaseClient<Database>;

export type ActionResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Create household
// ---------------------------------------------------------------------------

export async function createHousehold(
  supabase: Pick<DbClient, "rpc">,
  input: { name: string; displayName: string },
): Promise<ActionResult<{ householdId: string }>> {
  const name = input.name.trim();
  const displayName = input.displayName.trim();

  if (name === "") {
    return { ok: false, error: "Please enter a name for your household." };
  }
  if (displayName === "") {
    return { ok: false, error: "Please enter the name you'll go by." };
  }

  const { data, error } = await supabase.rpc("create_household", {
    p_name: name,
    p_display_name: displayName,
  });

  if (error || !data) {
    return {
      ok: false,
      error: "We couldn't create your household. Please try again.",
    };
  }

  return { ok: true, householdId: data };
}

// ---------------------------------------------------------------------------
// Generate invite
// ---------------------------------------------------------------------------

export async function generateInvite(
  supabase: Pick<DbClient, "from">,
  input: {
    householdId: string;
    createdBy: string;
    /** Injectable for tests; defaults to the CSPRNG minter. */
    mintToken?: () => string;
  },
): Promise<ActionResult<{ token: string; expiresAt: string | null }>> {
  const token = (input.mintToken ?? mintInviteToken)();

  // The owner-only INSERT is RLS-enforced (#4): a non-owner's insert is denied.
  const { data, error } = await supabase
    .from("invites")
    .insert({
      household_id: input.householdId,
      token,
      created_by: input.createdBy,
    })
    .select("token, expires_at")
    .single();

  if (error || !data) {
    return {
      ok: false,
      error: "We couldn't create an invite. Please try again.",
    };
  }

  return { ok: true, token: data.token, expiresAt: data.expires_at };
}

// ---------------------------------------------------------------------------
// Accept invite (join)
// ---------------------------------------------------------------------------

export async function acceptInvite(
  supabase: Pick<DbClient, "rpc">,
  input: { token: string; displayName: string },
): Promise<ActionResult<{ householdId: string }>> {
  const token = input.token.trim();
  const displayName = input.displayName.trim();

  if (token === "") {
    return { ok: false, error: "That invite link is missing its code." };
  }
  if (displayName === "") {
    return { ok: false, error: "Please enter the name you'll go by." };
  }

  const { data, error } = await supabase.rpc("accept_invite", {
    p_token: token,
    p_display_name: displayName,
  });

  if (error || !data) {
    // consume_invite/accept_invite raise on invalid/expired/consumed tokens and
    // on already-a-member; we surface a single clear message and never leak the
    // raw DB error (which could distinguish "expired" vs "consumed" for an
    // attacker probing tokens).
    return {
      ok: false,
      error: "That invite link isn't valid anymore. Ask for a fresh one.",
    };
  }

  return { ok: true, householdId: data };
}
