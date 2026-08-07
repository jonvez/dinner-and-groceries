# Slice 1d · Story #13 — Grocery schema + RLS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `catalog_items` (reusable staples) and `grocery_items` (the per-week shopping list) as household-scoped, FORCE-RLS tables, proven private by test-first pgTAP allow/deny.

**Architecture:** Two SQL migrations copying the established ingredients-table shape (denormalized `household_id`, composite FK to a parent that exposes `unique(id, household_id)`, per-FK indexes, `enable`+`force` RLS, `grant` to `authenticated`, four policies each keyed on `public.current_household_id()`). RLS is proven by pgTAP tests written *before* the migration. No app/TS logic in this story beyond regenerating `lib/database.types.ts`.

**Tech Stack:** Supabase Postgres, SQL migrations (`supabase/migrations/`), pgTAP (`supabase/tests/`), generated TS types (`lib/database.types.ts`).

## Global Constraints

- Every household-scoped table carries `household_id uuid not null` and is RLS-protected with BOTH `enable row level security` and `force row level security`. (SPEC.md security posture)
- Identity in policies comes ONLY from `public.current_household_id()` (existing SECURITY DEFINER helper, `search_path=''`, defined in `20260622210412_identity_schema.sql:98`). **Do not define a new helper.**
- `grant select, insert, update, delete on <table> to authenticated;` — RLS is the gate, the grant is broad.
- Migration filename: `YYYYMMDDHHMMSS_snake_case.sql` (UTC). Create via `npm run db:migration` (`sh scripts/supabase.sh migration new <name>`) so the timestamp is correct — **do not hand-invent the timestamp.**
- pgTAP test filename: `supabase/tests/NN_<table>_rls_test.sql`, next sequential number after the current max (currently `17_ingredients_rls_test.sql` → use `18`, `19`).
- **Quantity and unit are OPTIONAL** — `grocery_items.quantity numeric` and `grocery_items.unit text` are both nullable (kickoff scope decision 2026-08-07).
- No cost/price columns anywhere (out of MVP scope, SPEC.md).
- Regenerate types with `npm run db:types` after DDL lands; commit `lib/database.types.ts` in the same task.
- Run RLS tests with `npx supabase test db --local`.

## File Structure

- Create: `supabase/migrations/<ts>_catalog_items_schema.sql` — the staples catalog table + RLS.
- Create: `supabase/migrations/<ts>_grocery_items_schema.sql` — the per-week list table + RLS.
- Create: `supabase/tests/18_catalog_items_rls_test.sql` — allow/deny pgTAP for catalog_items.
- Create: `supabase/tests/19_grocery_items_rls_test.sql` — allow/deny pgTAP for grocery_items.
- Modify: `lib/database.types.ts` — regenerated (both new tables appear).

**Column contracts (authoritative — later stories build on these exact names):**

`public.catalog_items` (top-level household child, like `dishes`):
- `id uuid primary key default gen_random_uuid()`
- `household_id uuid not null references public.households(id) on delete cascade`
- `name text not null` with `check (length(btrim(name)) > 0)`
- `default_unit text` (nullable)
- `category text` (nullable)
- `last_added_at timestamptz` (nullable)
- `added_count integer not null default 0`
- `created_at timestamptz not null default now()`
- `unique (id, household_id)` (parity with other tables; lets future rows composite-FK to it)
- `unique index catalog_items_household_name_key on public.catalog_items (household_id, lower(name))` (case-insensitive dedupe of staples; promotion in #15 upserts on it)

`public.grocery_items` (per-week list; child of `weeks`):
- `id uuid primary key default gen_random_uuid()`
- `household_id uuid not null`
- `week_id uuid not null`
- `name text not null` with `check (length(btrim(name)) > 0)`
- `quantity numeric` (nullable — optional)
- `unit text` (nullable — optional)
- `ingredient_id uuid references public.ingredients(id) on delete set null` (nullable; roll-up provenance — simple FK so deleting a source dish/ingredient nulls provenance but never deletes the grocery row)
- `catalog_item_id uuid references public.catalog_items(id) on delete set null` (nullable; catalog feeder)
- `have_it boolean not null default false`
- `checked boolean not null default false`
- `edited boolean not null default false` (manual-edit flag; #14 uses it to protect rows from re-roll-up)
- `purchased_at timestamptz` (nullable; set by #15's complete-trip to soft-archive a checked row. Active list = `purchased_at is null`; #14 reads only unpurchased rows.)
- `position integer not null default 0`
- `created_at timestamptz not null default now()`
- `foreign key (week_id, household_id) references public.weeks (id, household_id) on delete cascade` (anchors denormalized `household_id` to a real same-household week)
- Indexes: `(household_id)`, `(week_id)`, `(ingredient_id)`, `(catalog_item_id)`

> **Note for later stories:** Realtime publication membership + `replica identity full` for `grocery_items` are added in **#15** (the live check-off story), not here — this story is schema + RLS only.

---

### Task 1: catalog_items table + RLS

**Files:**
- Create: `supabase/tests/18_catalog_items_rls_test.sql`
- Create: `supabase/migrations/<ts>_catalog_items_schema.sql`
- Modify: `lib/database.types.ts`

**Interfaces:**
- Consumes: `public.households(id)`, `public.members`, `public.current_household_id()` (existing).
- Produces: `public.catalog_items` with the columns listed above; `Database["public"]["Tables"]["catalog_items"]`.

- [ ] **Step 1: Write the failing pgTAP test.** Copy `supabase/tests/17_ingredients_rls_test.sql` as the template into `supabase/tests/18_catalog_items_rls_test.sql`. Adapt it to `catalog_items`: seed two households (H, K) + a member in each (reuse the fixed UUIDs and the inline `tests.authenticate_as`/`tests.clear_auth` helpers from the template). Seed one `catalog_items` row in H and one in K as the postgres role. Assert (plan count = number of asserts):
  - RLS enabled: `is((select relrowsecurity from pg_class where oid='public.catalog_items'::regclass), true, ...)`
  - RLS FORCEd: `is((select relforcerowsecurity from pg_class where oid='public.catalog_items'::regclass), true, ...)`
  - allow-same: authenticate as H's member → `count(*)=1` reading H's rows.
  - deny-cross read: same auth → `count(*)=0` reading K's rows.
  - deny-cross insert: `throws_ok($$insert into public.catalog_items(household_id,name) values ('<K uuid>','x')$$, '42501', null, ...)`
  - allow insert same-household: `lives_ok($$insert into public.catalog_items(household_id,name) values ('<H uuid>','olive oil')$$, ...)`

- [ ] **Step 2: Run it and watch it fail.** `npx supabase db reset --local && npx supabase test db --local`. Expected: FAIL — `relation "public.catalog_items" does not exist`.

- [ ] **Step 3: Write the migration.** `npm run db:migration catalog_items_schema`, then fill the generated file:

```sql
create table public.catalog_items (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  name          text not null,
  default_unit  text,
  category      text,
  last_added_at timestamptz,
  added_count   integer not null default 0,
  created_at    timestamptz not null default now(),
  constraint catalog_items_name_not_blank check (length(btrim(name)) > 0),
  unique (id, household_id)
);

create index catalog_items_household_id_idx on public.catalog_items (household_id);
create unique index catalog_items_household_name_key
  on public.catalog_items (household_id, lower(name));

alter table public.catalog_items enable row level security;
alter table public.catalog_items force  row level security;

grant select, insert, update, delete on public.catalog_items to authenticated;

create policy catalog_items_select on public.catalog_items
  for select to authenticated
  using (household_id = public.current_household_id());
create policy catalog_items_insert on public.catalog_items
  for insert to authenticated
  with check (household_id = public.current_household_id());
create policy catalog_items_update on public.catalog_items
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());
create policy catalog_items_delete on public.catalog_items
  for delete to authenticated
  using (household_id = public.current_household_id());
```

- [ ] **Step 4: Run tests to verify they pass.** `npx supabase db reset --local && npx supabase test db --local`. Expected: `18_catalog_items_rls_test.sql` all green.

- [ ] **Step 5: Regenerate types.** `npm run db:types`. Confirm `catalog_items` now appears in `lib/database.types.ts`.

- [ ] **Step 6: Commit.**
```bash
git add supabase/tests/18_catalog_items_rls_test.sql supabase/migrations/*_catalog_items_schema.sql lib/database.types.ts
git commit -m "feat(grocery): add catalog_items staples table with FORCE RLS (#13)"
```

---

### Task 2: grocery_items table + RLS

**Files:**
- Create: `supabase/tests/19_grocery_items_rls_test.sql`
- Create: `supabase/migrations/<ts>_grocery_items_schema.sql`
- Modify: `lib/database.types.ts`

**Interfaces:**
- Consumes: `public.weeks (id, household_id)` (unique composite exists), `public.ingredients(id)`, `public.catalog_items(id)` (Task 1), `public.current_household_id()`.
- Produces: `public.grocery_items` with the columns listed above; `Database["public"]["Tables"]["grocery_items"]`.

- [ ] **Step 1: Write the failing pgTAP test.** Copy `supabase/tests/17_ingredients_rls_test.sql` into `supabase/tests/19_grocery_items_rls_test.sql`. Seed H and K, and for each seed a `weeks` row (needed for the composite FK). Seed one `grocery_items` row per household (name only, quantity/unit null — proves optional). Assert:
  - RLS enabled + FORCEd (via `pg_class`, both `catalog`/`grocery` style as in Task 1).
  - allow-same read `count(*)=1`; deny-cross read `count(*)=0`.
  - deny-cross insert throws `42501` (insert a `grocery_items` row with K's `household_id`+`week_id` while authed as H).
  - allow same-household insert with **quantity and unit NULL** succeeds (`lives_ok`) — proves optionality at the DB layer.
  - blank-name rejected: `throws_ok($$insert ... name=' ' ...$$, '23514', ...)` (check constraint).

- [ ] **Step 2: Run it and watch it fail.** `npx supabase db reset --local && npx supabase test db --local`. Expected: FAIL — `relation "public.grocery_items" does not exist`.

- [ ] **Step 3: Write the migration.** `npm run db:migration grocery_items_schema`, then:

```sql
create table public.grocery_items (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null,
  week_id         uuid not null,
  name            text not null,
  quantity        numeric,
  unit            text,
  ingredient_id   uuid references public.ingredients (id)  on delete set null,
  catalog_item_id uuid references public.catalog_items (id) on delete set null,
  have_it         boolean not null default false,
  checked         boolean not null default false,
  edited          boolean not null default false,
  purchased_at    timestamptz,
  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  constraint grocery_items_name_not_blank check (length(btrim(name)) > 0),
  foreign key (week_id, household_id)
    references public.weeks (id, household_id) on delete cascade
);

create index grocery_items_household_id_idx    on public.grocery_items (household_id);
create index grocery_items_week_id_idx          on public.grocery_items (week_id);
create index grocery_items_ingredient_id_idx    on public.grocery_items (ingredient_id);
create index grocery_items_catalog_item_id_idx  on public.grocery_items (catalog_item_id);

alter table public.grocery_items enable row level security;
alter table public.grocery_items force  row level security;

grant select, insert, update, delete on public.grocery_items to authenticated;

create policy grocery_items_select on public.grocery_items
  for select to authenticated
  using (household_id = public.current_household_id());
create policy grocery_items_insert on public.grocery_items
  for insert to authenticated
  with check (household_id = public.current_household_id());
create policy grocery_items_update on public.grocery_items
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());
create policy grocery_items_delete on public.grocery_items
  for delete to authenticated
  using (household_id = public.current_household_id());
```

- [ ] **Step 4: Run tests to verify they pass.** `npx supabase db reset --local && npx supabase test db --local`. Expected: both `18_` and `19_` green.

- [ ] **Step 5: Regenerate types.** `npm run db:types`. Confirm `grocery_items` appears in `lib/database.types.ts`.

- [ ] **Step 6: Commit.**
```bash
git add supabase/tests/19_grocery_items_rls_test.sql supabase/migrations/*_grocery_items_schema.sql lib/database.types.ts
git commit -m "feat(grocery): add grocery_items per-week list table with FORCE RLS (#13)"
```

## Self-Review

- **Spec coverage:** both tables + FORCE RLS + allow/deny tests (AC "saved per household and stay private") ✓; three-feeder shape (`ingredient_id`/`catalog_item_id`/both-null) ✓; `added_count`/`last_added_at` retained ✓; quantity/unit optional ✓; no cost columns ✓.
- **Placeholders:** none — full DDL + test asserts given.
- **Type consistency:** column names here are the contract #14/#15 consume; keep them verbatim.
