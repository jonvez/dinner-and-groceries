# Slice 1d · Story #14 — Roll-up / dedupe engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a week's slotted dishes into one combined grocery list — deduped by normalized-name + exact unit, quantities summed, **merging (never clobbering)** the family's manual edits — as a pure, exhaustively-tested `lib/` module plus a thin persisting server action.

**Architecture:** A pure planner `lib/grocery/rollup.ts` computes a `RollupPlan` (insert/update/delete sets + `added`/`removed` counts) from two plain inputs: the slotted ingredient lines and the existing grocery rows. It has zero I/O and is unit-tested to death. A `app/grocery/rollup-core.ts` orchestrator (injected Supabase client, like `ingest-core.ts`) reads the week→slots→dishes→ingredients join + existing `grocery_items`, calls the planner, and applies the plan. A thin `"use server"` action wraps the core. #15 consumes `buildGroceryList`.

**Tech Stack:** TypeScript, Vitest (`lib/` + core unit tests with an injected fake client), `@supabase/ssr` server client, Next server actions.

## Global Constraints

- **Dedupe key = `normalizeName(name)` + exact `unit`.** Reuse `normalizeName` from `lib/recipes/ingredient.ts` (trim/lowercase/collapse-ws/singularize). **No unit conversion** (ADR 0003). An **empty/absent unit is its own key** — two unit-less "eggs" merge; a null unit NEVER merges with a non-null unit.
- **Quantity + unit optional** (kickoff 2026-08-07). Summing quantities: **sum only present values; a null contributes nothing and is never coerced to 1**; if every contributor is null, the merged quantity stays `null`.
- **Duplicate slotting rolls up twice** — the caller passes a dish's ingredient lines once per slotting; the planner sums them (ADR 0003).
- **Merge, never clobber (ADR 0003):** a row is *protected* if `edited || checked || have_it` OR it is not dish-derived (`ingredient_id == null`, i.e. ad-hoc/catalog). Protected rows are NEVER updated or deleted, and they *claim their dedupe key* — the planner will not insert or update an auto-row for a key a protected row already occupies.
- **Untouched-only removal (ADR 0003):** an *untouched auto-row* (`ingredient_id != null && !edited && !checked && !have_it`) whose dedupe key is no longer produced by the current slotting is deleted. Nothing else is ever deleted.
- Surface **"N added, M removed"** — `added` = rows inserted, `removed` = untouched auto-rows deleted. Quantity refreshes on a surviving auto-row are neither.
- `*-core.ts` takes `supabase: Pick<DbClient, "from">` for unit-testing without a live DB; `type DbClient = SupabaseClient<Database>` (`@/lib/database.types`). The action uses `createServerComponentClient()` (`@/lib/supabase/server-component`) + an actor resolver; NEVER a service-role key; NEVER trusts form input for household/member.
- Co-located `*.test.ts`; run `npm test`.

## File Structure

- Create: `lib/grocery/rollup.ts` — pure planner (types + `planRollup` + helpers).
- Create: `lib/grocery/rollup.test.ts` — the exhaustive planner matrix.
- Create: `app/grocery/rollup-core.ts` — `buildGroceryList(supabase, {householdId, weekId})` (reads joins, calls planner, applies plan).
- Create: `app/grocery/rollup-core.test.ts` — core tests with an injected fake client.
- Create: `app/grocery/actor.ts` — `resolveGroceryActor(supabase)` (mirror `app/recipes/new/actor.ts`).
- Create: `app/grocery/actions.ts` — `"use server"` `buildGroceryListAction`.

**Type contract (authoritative — #15 consumes `buildGroceryList` + these types):**

```ts
// lib/grocery/rollup.ts
export type SlottedIngredient = {
  ingredientId: string;        // ingredients.id — provenance
  name: string;                // display name
  quantity: number | null;
  unit: string | null;
};
export type ExistingGroceryItem = {
  id: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  ingredientId: string | null;   // null ⇒ ad-hoc/catalog (protected)
  haveIt: boolean;
  checked: boolean;
  edited: boolean;
};
export type RolledUpInsert = {
  name: string;
  quantity: number | null;
  unit: string | null;
  ingredientId: string;          // provenance of first contributor
};
export type RolledUpUpdate = { id: string; quantity: number | null; ingredientId: string };
export type RollupPlan = {
  toInsert: RolledUpInsert[];
  toUpdate: RolledUpUpdate[];
  toDelete: string[];            // grocery_items ids
  added: number;                 // == toInsert.length
  removed: number;               // == toDelete.length
};
export function planRollup(
  slotted: SlottedIngredient[],
  existing: ExistingGroceryItem[],
): RollupPlan;
```

---

### Task 1: Pure planner `lib/grocery/rollup.ts`

**Files:**
- Create: `lib/grocery/rollup.test.ts`
- Create: `lib/grocery/rollup.ts`

**Interfaces:**
- Consumes: `normalizeName` from `@/lib/recipes/ingredient`.
- Produces: the types + `planRollup` above.

- [ ] **Step 1: Write the failing tests.** Create `lib/grocery/rollup.test.ts` covering the full matrix. Each case constructs `slotted`/`existing` and asserts on the returned plan:

```ts
import { describe, it, expect } from "vitest";
import { planRollup } from "./rollup";

const auto = (o: Partial<import("./rollup").ExistingGroceryItem> & { id: string }) => ({
  name: "x", quantity: null, unit: null, ingredientId: "i", haveIt: false,
  checked: false, edited: false, ...o,
});

describe("planRollup", () => {
  it("sums same normalized-name + same unit into one row", () => {
    const p = planRollup(
      [{ ingredientId: "i1", name: "Flour", quantity: 2, unit: "cup" },
       { ingredientId: "i2", name: "flour", quantity: 1, unit: "cup" }],
      [],
    );
    expect(p.toInsert).toEqual([{ name: "Flour", quantity: 3, unit: "cup", ingredientId: "i1" }]);
    expect(p.added).toBe(1);
  });

  it("lists un-mergeable units separately", () => {
    const p = planRollup(
      [{ ingredientId: "i1", name: "flour", quantity: 2, unit: "cup" },
       { ingredientId: "i2", name: "flour", quantity: 100, unit: "g" }],
      [],
    );
    expect(p.toInsert).toHaveLength(2);
  });

  it("keeps quantity null when every contributor is null (optional qty)", () => {
    const p = planRollup(
      [{ ingredientId: "i1", name: "eggs", quantity: null, unit: null },
       { ingredientId: "i2", name: "Eggs", quantity: null, unit: null }],
      [],
    );
    expect(p.toInsert).toEqual([{ name: "eggs", quantity: null, unit: null, ingredientId: "i1" }]);
  });

  it("sums only present quantities; a null contributes nothing (never 1)", () => {
    const p = planRollup(
      [{ ingredientId: "i1", name: "milk", quantity: 1, unit: "cup" },
       { ingredientId: "i2", name: "milk", quantity: null, unit: "cup" }],
      [],
    );
    expect(p.toInsert[0].quantity).toBe(1);
  });

  it("merges an unmerged null-unit with a real unit never (distinct keys)", () => {
    const p = planRollup(
      [{ ingredientId: "i1", name: "salt", quantity: null, unit: null },
       { ingredientId: "i2", name: "salt", quantity: 1, unit: "tsp" }],
      [],
    );
    expect(p.toInsert).toHaveLength(2);
  });

  it("updates an untouched auto-row's quantity in place (not added/removed)", () => {
    const p = planRollup(
      [{ ingredientId: "i1", name: "flour", quantity: 3, unit: "cup" }],
      [auto({ id: "g1", name: "flour", quantity: 2, unit: "cup", ingredientId: "iOld" })],
    );
    expect(p.toUpdate).toEqual([{ id: "g1", quantity: 3, ingredientId: "i1" }]);
    expect(p.toInsert).toHaveLength(0);
    expect(p.added).toBe(0);
    expect(p.removed).toBe(0);
  });

  it("leaves a surviving auto-row alone when quantity is unchanged", () => {
    const p = planRollup(
      [{ ingredientId: "i1", name: "flour", quantity: 2, unit: "cup" }],
      [auto({ id: "g1", name: "flour", quantity: 2, unit: "cup" })],
    );
    expect(p.toUpdate).toHaveLength(0);
    expect(p.toInsert).toHaveLength(0);
  });

  it("deletes an untouched auto-row whose source is no longer slotted", () => {
    const p = planRollup(
      [{ ingredientId: "i1", name: "flour", quantity: 2, unit: "cup" }],
      [auto({ id: "g1", name: "flour", quantity: 2, unit: "cup" }),
       auto({ id: "g2", name: "sugar", quantity: 1, unit: "cup" })],
    );
    expect(p.toDelete).toEqual(["g2"]);
    expect(p.removed).toBe(1);
  });

  it.each(["edited", "checked", "haveIt"] as const)(
    "never deletes a %s row even when its source is gone", (flag) => {
      const p = planRollup(
        [],
        [auto({ id: "g1", name: "sugar", quantity: 1, unit: "cup", [flag]: true } as never)],
      );
      expect(p.toDelete).toHaveLength(0);
    });

  it("never deletes an ad-hoc row (ingredientId null)", () => {
    const p = planRollup(
      [],
      [auto({ id: "g1", name: "chips", ingredientId: null })],
    );
    expect(p.toDelete).toHaveLength(0);
  });

  it("does not insert/update an auto-row for a key a protected (edited) row owns — merge not clobber", () => {
    const p = planRollup(
      [{ ingredientId: "i1", name: "flour", quantity: 3, unit: "cup" }],
      [auto({ id: "g1", name: "flour", quantity: 5, unit: "cup", edited: true })],
    );
    expect(p.toInsert).toHaveLength(0);
    expect(p.toUpdate).toHaveLength(0);
    expect(p.toDelete).toHaveLength(0);
    expect(p.added).toBe(0);
    expect(p.removed).toBe(0);
  });

  it("inserts a brand-new auto-row and counts it added", () => {
    const p = planRollup(
      [{ ingredientId: "i1", name: "butter", quantity: 1, unit: "stick" }],
      [],
    );
    expect(p.added).toBe(1);
    expect(p.toInsert[0].ingredientId).toBe("i1");
  });
});
```

- [ ] **Step 2: Run and watch fail.** `npm test -- rollup` → FAIL (`planRollup` not defined).

- [ ] **Step 3: Implement `lib/grocery/rollup.ts`.**

```ts
import { normalizeName } from "@/lib/recipes/ingredient";

export type SlottedIngredient = { ingredientId: string; name: string; quantity: number | null; unit: string | null };
export type ExistingGroceryItem = {
  id: string; name: string; quantity: number | null; unit: string | null;
  ingredientId: string | null; haveIt: boolean; checked: boolean; edited: boolean;
};
export type RolledUpInsert = { name: string; quantity: number | null; unit: string | null; ingredientId: string };
export type RolledUpUpdate = { id: string; quantity: number | null; ingredientId: string };
export type RollupPlan = { toInsert: RolledUpInsert[]; toUpdate: RolledUpUpdate[]; toDelete: string[]; added: number; removed: number };

const SEP = " ";
function dedupeKey(name: string, unit: string | null): string {
  return normalizeName(name) + SEP + (unit ?? "");
}
function sumQuantities(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? present.reduce((a, b) => a + b, 0) : null;
}
function isProtected(row: ExistingGroceryItem): boolean {
  return row.edited || row.checked || row.haveIt || row.ingredientId === null;
}

export function planRollup(slotted: SlottedIngredient[], existing: ExistingGroceryItem[]): RollupPlan {
  // 1) aggregate slotting into desired rows keyed by (normalizedName, unit)
  const desired = new Map<string, { name: string; quantities: (number | null)[]; unit: string | null; ingredientId: string }>();
  for (const s of slotted) {
    const key = dedupeKey(s.name, s.unit);
    const cur = desired.get(key);
    if (cur) cur.quantities.push(s.quantity);
    else desired.set(key, { name: s.name, quantities: [s.quantity], unit: s.unit, ingredientId: s.ingredientId });
  }

  // 2) classify existing rows
  const protectedKeys = new Set<string>();
  const autoByKey = new Map<string, ExistingGroceryItem>();
  for (const row of existing) {
    const key = dedupeKey(row.name, row.unit);
    if (isProtected(row)) protectedKeys.add(key);
    else if (!autoByKey.has(key)) autoByKey.set(key, row);
  }

  const toInsert: RolledUpInsert[] = [];
  const toUpdate: RolledUpUpdate[] = [];
  const consumed = new Set<string>();

  for (const [key, d] of desired) {
    if (protectedKeys.has(key)) { consumed.add(key); continue; } // manual row owns this key
    const quantity = sumQuantities(d.quantities);
    const existingAuto = autoByKey.get(key);
    if (existingAuto) {
      consumed.add(key);
      if (existingAuto.quantity !== quantity) toUpdate.push({ id: existingAuto.id, quantity, ingredientId: d.ingredientId });
    } else {
      toInsert.push({ name: d.name, quantity, unit: d.unit, ingredientId: d.ingredientId });
    }
  }

  // 3) untouched auto-rows with no current source → delete
  const toDelete: string[] = [];
  for (const [key, row] of autoByKey) {
    if (!consumed.has(key) && !desired.has(key)) toDelete.push(row.id);
  }

  return { toInsert, toUpdate, toDelete, added: toInsert.length, removed: toDelete.length };
}
```

- [ ] **Step 4: Run and verify pass.** `npm test -- rollup` → all green.

- [ ] **Step 5: Commit.**
```bash
git add lib/grocery/rollup.ts lib/grocery/rollup.test.ts
git commit -m "feat(grocery): pure roll-up/dedupe planner — merge not clobber (#14)"
```

---

### Task 2: Persisting orchestrator `app/grocery/rollup-core.ts`

**Files:**
- Create: `app/grocery/rollup-core.test.ts`
- Create: `app/grocery/rollup-core.ts`

**Interfaces:**
- Consumes: `planRollup` + types (Task 1); `Database` from `@/lib/database.types`.
- Produces: `buildGroceryList(supabase, args): Promise<BuildResult>` (consumed by the action + #15).

```ts
type BuildArgs = { householdId: string; weekId: string };
type BuildResult = { ok: true; added: number; removed: number } | { ok: false; error: string };
export function buildGroceryList(supabase: Pick<DbClient, "from">, args: BuildArgs): Promise<BuildResult>;
```

- [ ] **Step 1: Write the failing tests** (`app/grocery/rollup-core.test.ts`). Use a hand-rolled fake `supabase.from(table)` returning canned data for `slots` (embed → ingredients) and `grocery_items`, and capturing `.insert/.update/.delete` calls. Assert:
  - reads the slots→slot_dishes→dishes→ingredients embed and flattens a dish slotted twice into duplicated `SlottedIngredient`s (double-slot).
  - passes existing rows (mapped snake→camel: `ingredient_id`→`ingredientId`, `have_it`→`haveIt`) into the planner.
  - applies inserts with `household_id`/`week_id`/`ingredient_id` set from args + plan.
  - returns `{ ok: true, added, removed }` matching the plan.
  - on a query error returns `{ ok: false, error }` (generic).

- [ ] **Step 2: Run and watch fail.** `npm test -- rollup-core` → FAIL.

- [ ] **Step 3: Implement `app/grocery/rollup-core.ts`.** Read the join:
```ts
const { data: slotRows, error } = await supabase
  .from("slots")
  .select("slot_dishes(dish:dishes(ingredients(id, name, quantity, unit)))")
  .eq("week_id", weekId);
```
Flatten every `slot_dishes[].dish.ingredients[]` into `SlottedIngredient[]` (a dish appearing in two slot_dishes yields its ingredients twice). Read existing (only the ACTIVE list — purchased/archived rows are out of the roll-up's scope):
```ts
const { data: rows } = await supabase
  .from("grocery_items")
  .select("id, name, quantity, unit, ingredient_id, catalog_item_id, have_it, checked, edited")
  .eq("week_id", weekId)
  .is("purchased_at", null);
```
Map to `ExistingGroceryItem` (a row with `catalog_item_id` set but `ingredient_id` null still maps `ingredientId: null` → protected). Call `planRollup`, then apply:
  - `toInsert` → `supabase.from("grocery_items").insert(rows.map(r => ({ household_id: householdId, week_id: weekId, name: r.name, quantity: r.quantity, unit: r.unit, ingredient_id: r.ingredientId })))`
  - `toUpdate` → per row `.update({ quantity, ingredient_id }).eq("id", id)`
  - `toDelete` → `.delete().in("id", toDelete)` (guard empty array)
Return counts. Any error → `{ ok: false, error: "Could not build the grocery list." }`.

- [ ] **Step 4: Run and verify pass.** `npm test -- rollup-core` → green.

- [ ] **Step 5: Commit.**
```bash
git add app/grocery/rollup-core.ts app/grocery/rollup-core.test.ts
git commit -m "feat(grocery): buildGroceryList orchestrator persists the roll-up plan (#14)"
```

---

### Task 3: Server action + actor resolver

**Files:**
- Create: `app/grocery/actor.ts`
- Create: `app/grocery/actions.ts`
- Create: `app/grocery/actor.test.ts`

**Interfaces:**
- Consumes: `createServerComponentClient` (`@/lib/supabase/server-component`), `buildGroceryList` (Task 2).
- Produces: `resolveGroceryActor(supabase): Promise<{ householdId: string; memberId: string } | null>`; `buildGroceryListAction(weekId): Promise<BuildResult>`.

- [ ] **Step 1: Write the failing actor test** (`app/grocery/actor.test.ts`), mirroring `app/recipes/new/actor.test.ts`: resolves `{ householdId, memberId }` from `auth.getUser()` → `rpc("current_household_id")` → `members` lookup; returns `null` (fails closed) when unauthenticated or no household.

- [ ] **Step 2: Run and watch fail.** `npm test -- grocery/actor` → FAIL.

- [ ] **Step 3: Implement `app/grocery/actor.ts`** (copy the shape of `app/recipes/new/actor.ts`, renamed `resolveGroceryActor`). Then `app/grocery/actions.ts`:
```ts
"use server";
import { createServerComponentClient } from "@/lib/supabase/server-component";
import { resolveGroceryActor } from "./actor";
import { buildGroceryList } from "./rollup-core";

export async function buildGroceryListAction(weekId: string) {
  const supabase = await createServerComponentClient();
  const actor = await resolveGroceryActor(supabase);
  if (!actor) return { ok: false as const, error: "Could not build the grocery list." };
  return buildGroceryList(supabase, { householdId: actor.householdId, weekId });
}
```
(No `revalidatePath` here — #15 owns the `/grocery` route and will revalidate after calling this; keeping the action route-agnostic. If #15 needs it, it revalidates in its own wrapper.)

- [ ] **Step 4: Run and verify pass.** `npm test -- grocery/actor` → green; `npm test` whole suite green; `npm run typecheck` clean.

- [ ] **Step 5: Commit.**
```bash
git add app/grocery/actor.ts app/grocery/actions.ts app/grocery/actor.test.ts
git commit -m "feat(grocery): server action + fail-closed actor for roll-up (#14)"
```

## Self-Review

- **Spec coverage (AC map):** roll-up aggregates w/ provenance ✓ (Task 1+2); dedupe/sum same key, un-mergeable units separate ✓; double-slot twice ✓ (Task 2 flatten + Task 1 sum); merge-not-clobber + "N added, M removed" ✓; edit protection ✓; untouched-only removal ✓; pure lib + thin action ✓.
- **Placeholders:** none — full planner code + test matrix given.
- **Type consistency:** `SlottedIngredient`/`ExistingGroceryItem`/`RollupPlan`/`buildGroceryList` names are the contract #15 consumes — verbatim.
- **Optional qty/unit:** covered by the null-sum tests + empty-unit key.
