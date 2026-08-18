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
  setItemSection,
  GENERIC_ERROR,
} from "./mutations-core";
import {
  createSection,
  deleteSection,
  renameSection,
  reorderSections,
  SECTION_ERROR,
  type SectionResult,
} from "./sections-core";
import { buildGroceryList, type BuildGroceryListResult } from "./rollup-core";
import {
  completeTrip,
  promoteToCatalog,
  TRIP_ERROR,
  PROMOTE_ERROR,
  type CompleteTripResult,
  type PromotableItem,
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

/**
 * A section id is only ever a UUID our own DB minted. Anything else is junk and
 * becomes null rather than being forwarded to a write.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanSectionId(value: unknown): string | null {
  return typeof value === "string" && UUID_RE.test(value) ? value : null;
}

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

/**
 * The explicit "add these to our staples" confirm. Accepts either plain names
 * or `{ name, sectionId }` so an item filed into an aisle in the store keeps
 * that aisle when it becomes a staple (#137).
 */
export async function promoteToCatalogAction(
  names: (string | PromotableItem)[],
): Promise<PromoteResult> {
  if (!Array.isArray(names)) return { ok: false as const, error: PROMOTE_ERROR };

  // Bound + sanitized before it reaches the core: a request can't drive an
  // unbounded write loop or store an over-long name. `sectionId` is accepted
  // only in canonical UUID form — anything else becomes null rather than being
  // forwarded. The composite (section_id, household_id) FK is the real referee
  // (a foreign section is unstorable), so this is belt-and-braces against junk
  // reaching the write at all.
  const clean = names
    .map((entry) => {
      if (typeof entry === "string") return { name: entry, sectionId: null };
      if (entry && typeof entry === "object" && typeof entry.name === "string") {
        return { name: entry.name, sectionId: cleanSectionId(entry.sectionId) };
      }
      return null;
    })
    .filter((e): e is PromotableItem => e !== null)
    .map((e) => ({ ...e, name: e.name.trim().slice(0, MAX_NAME_LENGTH) }))
    .filter((e) => e.name !== "")
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

/**
 * Bounds for the section surface. Reordering is capped so a request cannot
 * drive an unbounded write loop — the same reason MAX_PROMOTIONS exists.
 */
const MAX_SECTIONS = 60;

/**
 * File an item into an aisle — and teach the staple, so it is filed once and
 * not again on every future trip (#137). `sectionId` is only ever a UUID our
 * own DB minted; anything else becomes null (which renders as Unsorted) rather
 * than being forwarded to a write. The composite `(section_id, household_id)`
 * FK is the real referee: a section belonging to another household is
 * unstorable, so a crafted id fails the write outright.
 */
export async function setItemSectionAction(
  id: string,
  sectionId: string | null,
): Promise<GroceryActionState> {
  if (typeof id !== "string" || id.trim() === "") return { error: GENERIC_ERROR };

  const supabase = await createServerComponentClient();
  const actor = await resolveGroceryActor(supabase);
  if (!actor) return { error: SIGNED_OUT_ERROR };

  const result = await setItemSection(supabase, {
    householdId: actor.householdId,
    id,
    sectionId: cleanSectionId(sectionId),
  });
  if (!result.ok) return { error: result.error };

  revalidatePath(GROCERY_PATH);
  return { ok: true };
}

/** Add an aisle. Lands at the end of the order unless told otherwise. */
export async function createSectionAction(
  name: string,
): Promise<SectionResult> {
  const supabase = await createServerComponentClient();
  const actor = await resolveGroceryActor(supabase);
  if (!actor) return { ok: false as const, error: SECTION_ERROR };

  const result = await createSection(supabase, {
    householdId: actor.householdId,
    name: String(name ?? "").trim().slice(0, MAX_NAME_LENGTH),
  });
  if (result.ok) revalidatePath(GROCERY_PATH);
  return result;
}

/** Rename an aisle. Writes one column; RLS scopes which row is reachable. */
export async function renameSectionAction(
  id: string,
  name: string,
): Promise<SectionResult> {
  if (typeof id !== "string" || id.trim() === "") {
    return { ok: false as const, error: SECTION_ERROR };
  }

  const supabase = await createServerComponentClient();
  const actor = await resolveGroceryActor(supabase);
  if (!actor) return { ok: false as const, error: SECTION_ERROR };

  const result = await renameSection(supabase, {
    id,
    name: String(name ?? "").trim().slice(0, MAX_NAME_LENGTH),
  });
  if (result.ok) revalidatePath(GROCERY_PATH);
  return result;
}

/** Put the aisles in the order this family's store actually uses. */
export async function reorderSectionsAction(
  orderedIds: string[],
): Promise<SectionResult> {
  if (!Array.isArray(orderedIds)) {
    return { ok: false as const, error: SECTION_ERROR };
  }

  const clean = orderedIds
    .filter((id): id is string => typeof id === "string")
    .map((id) => id.trim())
    .filter((id) => id !== "")
    .slice(0, MAX_SECTIONS);

  const supabase = await createServerComponentClient();
  const actor = await resolveGroceryActor(supabase);
  if (!actor) return { ok: false as const, error: SECTION_ERROR };

  const result = await reorderSections(supabase, { orderedIds: clean });
  if (result.ok) revalidatePath(GROCERY_PATH);
  return result;
}

/**
 * Remove an aisle. Its items are NOT deleted — the composite FK's
 * `on delete set null (section_id)` drops the pointer and they render as
 * Unsorted. Nobody loses a shopping list because a section was tidied up.
 */
export async function deleteSectionAction(id: string): Promise<SectionResult> {
  if (typeof id !== "string" || id.trim() === "") {
    return { ok: false as const, error: SECTION_ERROR };
  }

  const supabase = await createServerComponentClient();
  const actor = await resolveGroceryActor(supabase);
  if (!actor) return { ok: false as const, error: SECTION_ERROR };

  const result = await deleteSection(supabase, { id });
  if (result.ok) revalidatePath(GROCERY_PATH);
  return result;
}
