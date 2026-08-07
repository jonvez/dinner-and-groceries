"use server";

/**
 * Server Actions for the grocery list — the thin Next.js boundary for both the
 * roll-up (issue #14) and the shopper-facing list UI (issue #15). Every action
 * builds the RLS-scoped cookie-session client (it runs as the signed-in user;
 * there is NO service-role key on this path), resolves the caller's identity
 * from the VERIFIED session, delegates to a unit-tested core, then revalidates
 * `/grocery` so the actor's own server-rendered view is correct even if Realtime
 * is down.
 *
 * Untrusted input: `weekId` and row ids arrive from the client, but they only
 * ever NARROW a statement that RLS has already fenced to the caller's household
 * — and `grocery_items`'s composite FK `(week_id, household_id) → weeks` makes a
 * row in someone else's week literally unstorable (#13). `householdId` is never
 * read from the request; it comes from `resolveGroceryActor` only.
 */

import { revalidatePath } from "next/cache";

import { createServerComponentClient } from "@/lib/supabase/server-component";

import { resolveGroceryActor } from "./actor";
import {
  addAdHocItem,
  addCatalogItemToList,
  setChecked,
  setHaveIt,
  GENERIC_ERROR,
} from "./mutations-core";
import { buildGroceryList, type BuildGroceryListResult } from "./rollup-core";

/** The route every grocery action refreshes. */
const GROCERY_PATH = "/grocery";

const SIGNED_OUT_ERROR = "Sign in to edit the list.";

export type GroceryActionState = { ok: true } | { error: string } | null;

/** Rebuild the week's list from the agreed menu, merging manual edits (#14). */
export async function buildGroceryListAction(
  weekId: string,
): Promise<BuildGroceryListResult> {
  const supabase = await createServerComponentClient();
  const actor = await resolveGroceryActor(supabase);
  if (!actor) return { ok: false as const, error: "Could not build the grocery list." };

  const result = await buildGroceryList(supabase, {
    householdId: actor.householdId,
    weekId,
  });
  if (result.ok) revalidatePath(GROCERY_PATH);
  return result;
}

/** One-tap staple: put a catalog item on this week's list. */
export async function addCatalogItemToListAction(
  weekId: string,
  catalogItemId: string,
): Promise<GroceryActionState> {
  if (typeof catalogItemId !== "string" || catalogItemId.trim() === "") {
    return { error: GENERIC_ERROR };
  }

  const supabase = await createServerComponentClient();
  const actor = await resolveGroceryActor(supabase);
  if (!actor) return { error: SIGNED_OUT_ERROR };

  const result = await addCatalogItemToList(supabase, {
    householdId: actor.householdId,
    weekId,
    catalogItemId,
  });
  if (!result.ok) return { error: result.error };

  revalidatePath(GROCERY_PATH);
  return { ok: true };
}

/**
 * Ad-hoc add (a `useActionState` form). `weekId` is bound server-side by the
 * caller; name is required, quantity and unit are optional — a bare "eggs" is a
 * valid list row, so an empty quantity stays NULL rather than becoming 1.
 */
export async function addAdHocItemAction(
  weekId: string,
  _prev: GroceryActionState,
  formData: FormData,
): Promise<GroceryActionState> {
  const supabase = await createServerComponentClient();
  const actor = await resolveGroceryActor(supabase);
  if (!actor) return { error: SIGNED_OUT_ERROR };

  const rawQuantity = String(formData.get("quantity") ?? "").trim();
  const quantity = rawQuantity === "" ? null : Number(rawQuantity);

  const result = await addAdHocItem(supabase, {
    householdId: actor.householdId,
    weekId,
    name: String(formData.get("name") ?? ""),
    quantity,
    unit: String(formData.get("unit") ?? ""),
  });
  if (!result.ok) return { error: result.error };

  revalidatePath(GROCERY_PATH);
  return { ok: true };
}

/** "We already have it" — de-emphasize without deleting. */
export async function setHaveItAction(
  id: string,
  haveIt: boolean,
): Promise<GroceryActionState> {
  if (typeof id !== "string" || id.trim() === "") return { error: GENERIC_ERROR };

  const supabase = await createServerComponentClient();
  const actor = await resolveGroceryActor(supabase);
  if (!actor) return { error: SIGNED_OUT_ERROR };

  const result = await setHaveIt(supabase, { id, haveIt: haveIt === true });
  if (!result.ok) return { error: result.error };

  revalidatePath(GROCERY_PATH);
  return { ok: true };
}

/** Check-off / un-check — the edit the other shopper sees live. */
export async function setCheckedAction(
  id: string,
  checked: boolean,
): Promise<GroceryActionState> {
  if (typeof id !== "string" || id.trim() === "") return { error: GENERIC_ERROR };

  const supabase = await createServerComponentClient();
  const actor = await resolveGroceryActor(supabase);
  if (!actor) return { error: SIGNED_OUT_ERROR };

  const result = await setChecked(supabase, { id, checked: checked === true });
  if (!result.ok) return { error: result.error };

  revalidatePath(GROCERY_PATH);
  return { ok: true };
}
