"use server";

/**
 * Server Actions for the grocery roll-up (issue #14) — the thin Next.js
 * boundary. Build the RLS-scoped cookie-session client (runs as the signed-in
 * user; no service-role key), resolve the caller's identity from the VERIFIED
 * session, then delegate to the pure-ish `rollup-core` orchestration. The
 * `weekId` argument only narrows a query RLS already scopes to the caller's
 * household, so it can never reach another household's data.
 *
 * No `revalidatePath` here: #15 owns the `/grocery` route and revalidates after
 * calling this, keeping the action route-agnostic.
 */

import { createServerComponentClient } from "@/lib/supabase/server-component";

import { resolveGroceryActor } from "./actor";
import { buildGroceryList, type BuildGroceryListResult } from "./rollup-core";

export async function buildGroceryListAction(
  weekId: string,
): Promise<BuildGroceryListResult> {
  const supabase = await createServerComponentClient();
  const actor = await resolveGroceryActor(supabase);
  if (!actor) return { ok: false as const, error: "Could not build the grocery list." };

  return buildGroceryList(supabase, { householdId: actor.householdId, weekId });
}
