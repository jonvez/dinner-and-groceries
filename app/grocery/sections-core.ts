/**
 * Grocery sections — the aisle grouping for the shopping list (issue #137,
 * epic #135). Injected Supabase-like client, like every other `*-core` module
 * here, so each statement is unit-tested without a live DB; the thin Server
 * Actions supply the RLS-scoped cookie-session client.
 *
 * These replace a manual habit rather than encode one: the family's previous
 * list used unlabeled separator rows that were re-sorted BY HAND on every
 * shopping trip. A section assignment here is durable, so the same correction
 * is never made twice.
 *
 * ## Two ways to be unsorted, one meaning
 *
 * A `section_id` of NULL and a pointer at the household's "Unsorted" section
 * mean the SAME thing and render in the same group. That is deliberate: the FK
 * is `on delete set null (section_id)`, so deleting a section re-homes its
 * items to NULL — which must land them in Unsorted without a second write and
 * without ever deleting a row the shopper is standing in the store with.
 * `resolveSectionId` is the single place that collapses the two.
 *
 * Security: `householdId` always comes from the caller's VERIFIED session,
 * never request input, and is written onto every insert so the `with check`
 * policy applies. Row ids are not trusted — an id from another household
 * matches no row under RLS, so the write silently affects nothing (fails
 * closed). There is no service-role path.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DbClient = SupabaseClient<Database>;

export type SectionRow = {
  id: string;
  name: string;
  position: number;
};

export type SectionResult = { ok: true } | { ok: false; error: string };

/** One generic message for every failure — never leak a database error. */
export const SECTION_ERROR = "Could not update the sections.";
export const BLANK_SECTION_NAME_ERROR = "Give the section a name.";

/** Postgres unique-violation — that section name already exists here. */
const UNIQUE_VIOLATION = "23505";
export const DUPLICATE_SECTION_ERROR = "There's already a section with that name.";

/** The name every household's catch-all section carries (seeded by trigger). */
export const UNSORTED_SECTION_NAME = "Unsorted";

/** Selected columns, shared with the client component's Realtime re-fetch. */
export const SECTION_COLUMNS = "id, name, position";

type DbSectionRow = { id: string; name: string; position: number };

/**
 * The household's sections in aisle order. A failed read yields an empty array
 * rather than throwing, matching `loadGroceryList` — the list still renders
 * (ungrouped) instead of 500ing in the middle of a grocery aisle.
 */
export async function loadSections(
  supabase: Pick<DbClient, "from">,
  // `householdId` is optional defense-in-depth: RLS already fences this read to
  // the caller's household, so the read path (loadGroceryList) omits it exactly
  // as it does for the catalog. The write paths pass it, matching
  // promoteToCatalog.
  options: { householdId?: string } = {},
): Promise<SectionRow[]> {
  const query = supabase.from("grocery_sections").select(SECTION_COLUMNS);
  const scoped =
    options.householdId === undefined
      ? query
      : query.eq("household_id", options.householdId);

  const { data } = await scoped.order("position").order("name");

  return ((data ?? []) as unknown as DbSectionRow[]).map((row) => ({
    id: row.id,
    name: row.name,
    position: row.position,
  }));
}

/**
 * Collapse "no section" and "the Unsorted section" into one id, so grouping and
 * ordering never have to special-case NULL. Returns null only when the
 * household has no Unsorted section at all (it was renamed or deleted), in
 * which case the caller groups by null and still renders every item.
 */
export function resolveSectionId(
  sectionId: string | null,
  sections: SectionRow[],
): string | null {
  if (sectionId !== null) return sectionId;
  const unsorted = sections.find(
    (section) => section.name.toLowerCase() === UNSORTED_SECTION_NAME.toLowerCase(),
  );
  return unsorted?.id ?? null;
}

/** One rendered aisle: its identity, its label, and the rows filed into it. */
export type SectionGroup<T> = {
  /** null only when the household has no Unsorted section to collapse onto. */
  id: string | null;
  name: string;
  items: T[];
};

/**
 * Bucket the list into aisles for rendering, in the household's section order.
 *
 * Generic over the item so this stays free of `list-core` (which imports THIS
 * module — a concrete `GroceryRow` here would close the cycle).
 *
 * Three rules, each of which exists to protect a shopper standing in a store:
 *   - An EMPTY section is omitted. An aisle you are not buying from is noise on
 *     a phone screen.
 *   - A NULL pointer collapses onto Unsorted (`resolveSectionId`), so the row's
 *     picker shows "Unsorted" selected rather than sitting on a phantom value.
 *   - An UNKNOWN pointer — a section another phone deleted, still referenced by
 *     rows in this render until the next server snapshot — falls back to
 *     Unsorted rather than vanishing. Dropping a row mid-aisle is the worst
 *     outcome available, so nothing is ever grouped out of existence.
 *
 * Input order is preserved within each group, so `loadGroceryList`'s
 * position/created_at ordering still decides the order inside an aisle.
 */
export function groupBySection<T extends { sectionId: string | null }>(
  items: T[],
  sections: SectionRow[],
): SectionGroup<T>[] {
  const known = new Set(sections.map((section) => section.id));
  const buckets = new Map<string | null, T[]>();
  // The bucket unresolvable pointers fall into: the real Unsorted section when
  // there is one, else a null-keyed group that still renders.
  const fallback = resolveSectionId(null, sections);

  for (const item of items) {
    const resolved = resolveSectionId(item.sectionId, sections);
    const key = resolved !== null && known.has(resolved) ? resolved : fallback;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  const groups: SectionGroup<T>[] = [];
  for (const section of sections) {
    const bucketed = buckets.get(section.id);
    if (bucketed) groups.push({ id: section.id, name: section.name, items: bucketed });
  }

  // Only reachable when there is no Unsorted section to have collected them.
  const orphans = buckets.get(null);
  if (orphans) {
    groups.push({ id: null, name: UNSORTED_SECTION_NAME, items: orphans });
  }

  return groups;
}

/**
 * `lower(name)` → the household's catalog row, for section inheritance. Read
 * ONCE per operation and matched in TypeScript, never as a per-name `ilike`:
 * PostgREST aliases `*` to `%` in a LIKE pattern and rewrites an escaped `\*`
 * into a literal `\%`, so a typed name can neither be escaped safely nor
 * trusted as a pattern (see the `trip-core.ts` header). Keyed exactly the way
 * the `(household_id, lower(name))` unique index is.
 */
export async function loadCatalogSectionIndex(
  supabase: Pick<DbClient, "from">,
  { householdId }: { householdId: string },
): Promise<Map<string, { id: string; sectionId: string | null }>> {
  const { data } = await supabase
    .from("catalog_items")
    .select("id, name, section_id")
    .eq("household_id", householdId);

  const rows = (data ?? []) as unknown as {
    id: string;
    name: string;
    section_id: string | null;
  }[];

  return new Map(
    rows.map((row) => [
      row.name.trim().toLowerCase(),
      { id: row.id, sectionId: row.section_id },
    ]),
  );
}

/** The section a newly-added item should land in, by matching a known staple. */
export function inheritSectionId(
  name: string,
  index: Map<string, { id: string; sectionId: string | null }>,
): string | null {
  return index.get(name.trim().toLowerCase())?.sectionId ?? null;
}

/**
 * Add a section. `position` defaults to the end of the household's current
 * order so a new aisle never silently inserts itself mid-shop.
 */
export async function createSection(
  supabase: Pick<DbClient, "from">,
  input: {
    /** From the caller's VERIFIED session — never request input. */
    householdId: string;
    name: string;
    position?: number;
  },
): Promise<SectionResult> {
  const name = (input.name ?? "").trim();
  if (name === "") return { ok: false, error: BLANK_SECTION_NAME_ERROR };

  let position = input.position;
  if (typeof position !== "number" || !Number.isFinite(position)) {
    const existing = await loadSections(supabase, { householdId: input.householdId });
    position = existing.reduce((max, s) => Math.max(max, s.position), 0) + 10;
  }

  const { error } = await supabase.from("grocery_sections").insert({
    household_id: input.householdId,
    name,
    position,
  });

  if (error) {
    return (error as { code?: string }).code === UNIQUE_VIOLATION
      ? { ok: false, error: DUPLICATE_SECTION_ERROR }
      : { ok: false, error: SECTION_ERROR };
  }
  return { ok: true };
}

/**
 * Rename a section. Writes ONE column, so a crafted call cannot ride along and
 * re-home the row or change its order.
 */
export async function renameSection(
  supabase: Pick<DbClient, "from">,
  input: { id: string; name: string },
): Promise<SectionResult> {
  const name = (input.name ?? "").trim();
  if (name === "") return { ok: false, error: BLANK_SECTION_NAME_ERROR };

  const { error } = await supabase
    .from("grocery_sections")
    .update({ name })
    .eq("id", input.id);

  if (error) {
    return (error as { code?: string }).code === UNIQUE_VIOLATION
      ? { ok: false, error: DUPLICATE_SECTION_ERROR }
      : { ok: false, error: SECTION_ERROR };
  }
  return { ok: true };
}

/**
 * Reorder the household's aisles. Takes the ids in their new order and
 * renumbers them sparsely (10, 20, 30...) so a later single-section move can be
 * slotted between two neighbours without renumbering everything again.
 *
 * Only `position` is written. An id from another household matches no row under
 * RLS and is skipped silently — the uniform outcome denies an existence oracle,
 * exactly as the item toggles do.
 */
export async function reorderSections(
  supabase: Pick<DbClient, "from">,
  input: { orderedIds: string[] },
): Promise<SectionResult> {
  const ids = (input.orderedIds ?? []).filter(
    (id) => typeof id === "string" && id !== "",
  );

  for (const [index, id] of ids.entries()) {
    const { error } = await supabase
      .from("grocery_sections")
      .update({ position: (index + 1) * 10 })
      .eq("id", id);
    if (error) return { ok: false, error: SECTION_ERROR };
  }

  return { ok: true };
}

/**
 * Delete a section. Items pointing at it are NOT deleted: the composite FK's
 * `on delete set null (section_id)` drops the pointer, and a null pointer
 * renders as Unsorted (see the file header). The shopper's list survives intact.
 */
export async function deleteSection(
  supabase: Pick<DbClient, "from">,
  input: { id: string },
): Promise<SectionResult> {
  const { error } = await supabase
    .from("grocery_sections")
    .delete()
    .eq("id", input.id);
  if (error) return { ok: false, error: SECTION_ERROR };
  return { ok: true };
}
