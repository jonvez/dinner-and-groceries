# Recipe steps as data: design

**Status:** design for issue (Slice A of the recipe-hardening track). Written 2026-11-11 after two real
cooks: the cilantro lime soup (2026-11-07) and the no-boil baked rigatoni (2026-11-11).
**Evidence:** `docs/briefs/2026-11-07-recipe-spike-software-notes.md` (running notes).
**Jon's ask:** "harden this spike … augment the data model to include ingredient groups and break out
the method / steps from description, and anything else that I might have missed."
Jon then said "start building against these notes" while cooking, so the questions were skipped. Every
choice below that isn't a direct quote from Jon is **the builder's call**, marked *(call)*.

## Intent

Cook mode (PR #271) works, but it is a spike. The method lives as markdown in `dishes.description` and
is parsed on every render. Cook progress is keyed by step **number**, so any edit mid-cook scrambles it.
The write path is non-atomic and reachable only through a form-coupled server action.

This slice makes the recipe's structure real data, behind **one atomic write path**. Three callers use
it: the app's add form today, the MCP companion next, and a future edit UI (#89). The UX does not
change: chronological timeline, inline ingredient chips, tap to mark a step done, minimal scrolling.

## Goals

1. **Phases and steps are rows**, not text: `dish_phases`, `dish_steps`.
2. **Steps have stable identities.** Cook progress is keyed by step id. Revising a recipe keeps the
   ids of steps whose text didn't change, so an edit made during a cook doesn't reset or scramble
   progress. (Rigatoni evidence: moving the oven step renumbered steps 1–4.)
3. **Ingredient groups** ("Filling", "Topping", "Soup base"). An optional `section` on each ingredient
   row; the full ingredient list renders grouped.
4. **Servings / yield**: `dishes.servings text` (e.g. "6 to 8").
5. **One atomic write path**: `public.save_recipe(p_recipe jsonb) returns uuid`, `security invoker` so
   RLS does all the scoping. A TS domain function `saveRecipe(client, input)` wraps it. Every writer
   calls that function. Nothing reimplements parsing or inserts.
6. **The add form gains a Method textarea** (markdown, same syntax as the spike), so a new recipe
   can carry steps without SQL.
7. **Backfill**: the two prod recipes (soup, rigatoni) get rows, with no manual prod step.

## Non-goals (this slice; each has its own backlog issue)

- **Steps referencing ingredient rows.** Chips stay `[[text]]` tokens in step text, so no scaling and
  no "what's left to add" yet. (Slice B.)
- **Timed steps and clock cues** ("oven on when the soak timer shows 15 min left"), and timer alerts
  in cook mode. (Slice C.)
- **The edit UI** (#89). The domain function is built so #89 is purely UI.
- **Cook sessions, corrections, verdicts, versions.** (Slice E.)
- **Cross-dish links** (one pork butt feeding soup and carnitas).
- **The MCP identity/token exchange.** That is the MCP spec, separately.

## Anti-goals

- **Two sources of truth for a method.** Rows are the truth. Markdown is only an *input* format,
  parsed once on save. *(call)*
- **A regression in cook mode's feel.** Same layout, same chips, same tap-to-done, same auto-scroll,
  same sticky toolbar and hint.
- **Weakening RLS.** No `security definer` on the write path and no service role.

## Data model

All new tables follow ADR 0003:

- `household_id` is denormalized onto every child table.
- A composite FK `(dish_id, household_id) → dishes(id, household_id)` with `on delete cascade`.
- FORCE RLS, with the four policies on `household_id = public.current_household_id()`, mirroring
  `ingredients`.
- The `authenticated` grants match `ingredients`.
- `household_id` index plus a `dish_id` index.

```
dish_phases
  id uuid pk default gen_random_uuid()
  household_id uuid not null
  dish_id uuid not null
  position int not null            -- 0-based order within the dish
  title text not null default ''   -- '' = untitled leading phase
  intro text[] not null default '{}'  -- intro lines / phase-level notes
  created_at timestamptz not null default now()
  unique (dish_id, position)
  FK (dish_id, household_id) → dishes

dish_steps
  id uuid pk default gen_random_uuid()
  household_id uuid not null
  dish_id uuid not null
  phase_id uuid not null → dish_phases(id) on delete cascade
  position int not null            -- 0-based order across the WHOLE dish (display n = position+1)
  body text not null check (length(trim(body)) > 0)
  notes text[] not null default '{}'
  created_at timestamptz not null default now()
  unique (dish_id, position)  -- deferrable initially deferred (reorders inside one txn)
  FK (dish_id, household_id) → dishes

ingredients  + section text null   -- ingredient group label; null = ungrouped
dishes       + servings text null
```

**Hardening the phase–step relation.** `phase_id` must belong to the same dish. Enforce it with a
composite FK `(phase_id, dish_id) → dish_phases(id, dish_id)`, which needs a unique `(id, dish_id)` on
`dish_phases`. *(call)*

Display numbering is `position + 1` across the whole dish, matching the spike's global renumbering.

## The write path

### `save_recipe(p_recipe jsonb) returns uuid`

`security invoker`, `set search_path = ''`, plpgsql, granted to `authenticated` only (revoke from
public/anon). Input shape:

```jsonc
{
  "id": "uuid | null",          // null = create; present = replace this dish's content
  "title": "…", "source_url": "…|null", "image_url": "…|null",
  "prep_minutes": 10, "cook_minutes": 60, "total_minutes": 110, "servings": "6 to 8|null",
  "tags": ["pasta"],             // optional; omitted = leave tags unchanged on update, '{}' on create
  "ingredients": [ { "name", "quantity", "unit", "raw_text", "section" } ],   // order = position
  "phases": [ { "title", "intro": [..], "steps": [ { "id": "uuid|null", "body", "notes": [..] } ] } ]
}
```

Semantics, all in one transaction:

1. **Create.** Insert the dish with `household_id = public.current_household_id()` and
   `created_by` = the caller's member id (`select id from public.members where user_id = auth.uid()`).
   Never client-supplied. Raise `28000` if either is null.
2. **Update.** `update dishes … where id = p_recipe->>'id'`. If no row was updated (bad id, or another
   household's dish hidden by RLS), raise `P0002` "recipe not found". Never create in that case. That
   is the idempotency rule: an assistant holding an id updates or fails; it never duplicates.
3. **Ingredients.** Delete all rows for the dish, then insert the given rows in order. Ingredient ids
   are not yet referenced by anything (Slice B changes this).
4. **Phases.** Delete all rows for the dish, then insert in order.
5. **Steps.**
   - A step with a non-null `id` is upserted on that id: `insert … on conflict (id) do update`. RLS
     WITH CHECK keeps it inside the household, and the dish/phase are rewritten to this dish.
   - A step with no id gets a new id.
   - Steps of this dish whose ids aren't in the input are deleted.
   - Do the deletes and the phase replacement in an order that doesn't violate the FKs. One way:
     delete stale steps, re-point kept steps after the new phases exist, then delete the old phases.
     Exact ordering is the builder's call.
6. Return the dish id.

Validation in SQL: a non-empty trimmed title, step bodies non-empty (the check constraint), positions
assigned by the function from array order. Clients never send positions.

**`description` is left alone.** It is never written by `save_recipe` and never read by the app after
this slice. *(call)* It keeps the legacy markdown for the soup/rigatoni, which is harmless. A later
**contract** migration can null it once no deployed app reads it. That cannot be in this slice, because
of the expand-only rule (ADR 0015): the old container renders `description` during the deploy window.

### Domain layer: `lib/recipes/save-recipe.ts`

```ts
type RecipeInput = {
  id?: string | null; title: string; sourceUrl?: string | null; imageUrl?: string | null;
  prepMinutes?: number | null; cookMinutes?: number | null; totalMinutes?: number | null;
  servings?: string | null; tags?: string[];
  ingredientsText: string;   // one per line; "## Section" lines open a group
  methodText: string;        // spike markdown (## phase / N. step / - note / [[chip]] / **bold**)
};
saveRecipe(supabase, input): Promise<{ ok: true; dishId } | { ok: false; error }>
```

- **URLs.** Scrubs `sourceUrl`/`imageUrl` through `safeHttpUrl`, with the same drop-not-reject rule as
  `ingest-core`.
- **Ingredients.** Parses them with `parseIngredient`, keeping today's name-fallback rule, plus
  section headers.
- **Method.** Parses it with `parseMethod`, which moves from `app/recipes/[id]/method-parse.ts` to
  `lib/recipes/method-parse.ts`; the app imports it from there.
- **Stable ids on update.** Before calling the RPC, load the dish's current steps and give each
  incoming step the id of an existing step with **identical trimmed body**, first unused match, in
  order. A duplicate body text maps one-to-one in order.
- Calls `rpc("save_recipe", …)`.

`saveIngestedDish` (the add form) becomes a thin adapter over `saveRecipe`. The `ingredientsSaved`
partial-success state disappears, because the save is atomic now. Keep the `sourceUrl`-gated
`recipe_ingested` event behaviour and its PRG redirect.

**Ingredient section syntax** *(call)*: a line `## Filling` in the ingredients textarea opens a group,
and lines after it get `section = 'Filling'`. Lines before any header get `section = null`. This is
the same `##` convention as the method.

## Reading and rendering

- **The detail loader** (`detail-core.ts`) reads:
  - phases (ordered),
  - steps (ordered, with ids),
  - ingredients (with `section`),
  - `servings`.

  It returns `method: { phases: [{ title, intro, steps: [{ id, n, body, notes }] }] } | null` (null
  when there are no steps and no phases) and `ingredientGroups: [{ section: string|null, lines: string[] }]`.
- **`RecipeMethod`** takes structured phases instead of markdown. Progress is keyed by step id,
  `localStorage` key `cook-progress:v2:${dishId}`, value = a JSON array of step ids. Old number-based
  keys are ignored: a fresh start, accepted *(call)*. "Current step" = the first step in order whose id
  isn't done.
- **The ingredients `<details>`** renders a group heading per non-null section.
- **Servings** shows next to the time meta when present.

## Backfill (in the migration)

A plpgsql block in the migration parses `dishes.description` for every dish that has non-blank
description text and no phases yet, using the **same rules** as `parseMethod`:

- Trim each line and skip blanks.
- `## ` opens a phase.
- `^\d+\.\s+` is a step.
- `^[-*]\s+` is a note on the last step of the current phase, or a phase intro line if the phase has
  no step yet.
- Any other line is an intro line.
- Steps before any heading go into an untitled phase.

It inserts the phases and steps with the dish's own `household_id`. This runs as the migration owner,
so RLS is bypassed: acceptable for a one-shot data migration, scoped by `dish_id`/`household_id` from
the dish row itself.

**Parity test (required):**

- Seed a dish whose description is the soup's method (`scripts/spike/cilantro-lime-soup.md` on the
  spike branch, copied into a fixture) and another with the rigatoni method.
- Run the backfill and assert that the phase titles, step count, step bodies and notes equal what
  `parseMethod` returns.
- Do it as a pgTAP test over the backfill function (keep the parsing in a named function,
  `public._backfill_dish_method(dish_id)`, dropped at the end of the migration *or* kept private with
  execute revoked). Builder's call which. A Vitest-side fixture can supply the expected values.

## Tests

- **pgTAP** (new `24_dish_steps_rls_test.sql`, `25_save_recipe_test.sql`):
  - RLS isolation for both tables, with a cross-household read/write denied.
  - The composite FKs.
  - `save_recipe`:
    - create;
    - update by id;
    - update with another household's id → `P0002`, nothing written;
    - a stale step deleted;
    - a kept step id preserved;
    - unauthenticated → error;
    - `anon` has no execute.
  - `21_table_grants_test.sql` / `23_default_privileges_test.sql` updated if they enumerate tables.
  - The backfill parity check.
- **Vitest:**
  - section parsing;
  - the stable-id matching (same body keeps id; reordered steps keep ids; an edited body gets a new
    id; duplicates map in order);
  - `saveRecipe` passes the right jsonb to an injected `rpc` mock;
  - the detail loader shape;
  - `RecipeMethod` progress keyed by id (an edit that inserts a step before a done step keeps that
    step done);
  - grouped ingredient rendering.
- **E2E smoke:** unchanged, plus the add form saves a recipe with a method and the detail page shows
  "Step 1 of N".
- Regenerate `lib/database.types.ts` (`npm run db:types`).

## Constraints

- **Expand-only migration** (ADR 0015). The old app must keep working against the new schema. It
  reads `description`, which is untouched.
- **Required CI checks:** lint/typecheck/unit, Playwright smoke, RLS pgTAP, the Docker build.
- **No new dependencies.**
- **Next.js 16.** Read `node_modules/next/dist/docs/` before touching routing or server-action
  conventions (AGENTS.md).

## Left to the builder

- Statement ordering inside `save_recipe`.
- Whether the backfill helper is dropped or kept with execute revoked.
- Component decomposition.
- Exact copy for the servings meta.
