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
import {
  completeTrip,
  promoteToCatalog,
  TRIP_ERROR,
  PROMOTE_ERROR,
  type CompleteTripResult,
  type PromoteResult,
} from "./trip-core";

/** The route every grocery action refreshes. */
const GROCERY_PATH = "/grocery";

const SIGNED_OUT_ERROR = "Sign in to edit the list.";

/**
 * Bounds on untrusted text. A Server Action is a PUBLIC endpoint — the form's
 * `maxLength` is a browser hint, not a control — so every free-text field is
 * trimmed and sliced here, on the server, before it reaches a core.
 */
const MAX_PROMOTIONS = 100;
const MAX_NAME_LENGTH = 200;
const MAX_UNIT_LENGTH = 40;

/** Trim, then bound — padding must not eat a field's allowance. */
function boundedText(value: FormDataEntryValue | null, max: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

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
 * Ad-hoc add (a `useActionState` form). `weekId` is bound by the CLIENT
 * component, so it is untrusted input that only narrows an RLS-fenced statement;
 * name is required, quantity and unit are optional — a bare "eggs" is a valid
 * list row, so an empty quantity stays NULL rather than becoming 1. Name and
 * unit are bounded here because a request need not come from the form.
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
    name: boundedText(formData.get("name"), MAX_NAME_LENGTH),
    quantity,
    unit: boundedText(formData.get("unit"), MAX_UNIT_LENGTH),
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

/**
 * Finish the trip: archive what's in the cart and report which newly-typed
 * items could become staples. Promotion is NOT done here — the shopper picks
 * from the returned candidates and confirms (`promoteToCatalogAction`).
 */
export async function completeTripAction(
  weekId: string,
): Promise<CompleteTripResult> {
  const supabase = await createServerComponentClient();
  const actor = await resolveGroceryActor(supabase);
  if (!actor) return { ok: false as const, error: TRIP_ERROR };

  const result = await completeTrip(supabase, {
    householdId: actor.householdId,
    weekId,
  });
  if (result.ok) revalidatePath(GROCERY_PATH);
  return result;
}

/** The explicit "add these to our staples" confirm. */
export async function promoteToCatalogAction(
  names: string[],
): Promise<PromoteResult> {
  if (!Array.isArray(names)) return { ok: false as const, error: PROMOTE_ERROR };

  // Bound + sanitized before it reaches the core: a request can't drive an
  // unbounded write loop or store an over-long name.
  const clean = names
    .filter((n): n is string => typeof n === "string")
    .map((n) => n.trim().slice(0, MAX_NAME_LENGTH))
    .filter((n) => n !== "")
    .slice(0, MAX_PROMOTIONS);

  const supabase = await createServerComponentClient();
  const actor = await resolveGroceryActor(supabase);
  if (!actor) return { ok: false as const, error: PROMOTE_ERROR };

  const result = await promoteToCatalog(supabase, {
    householdId: actor.householdId,
    names: clean,
  });
  if (result.ok) revalidatePath(GROCERY_PATH);
  return result;
}
