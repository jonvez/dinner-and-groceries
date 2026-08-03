# 12b — `ingredients` table + RLS + pgTAP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A household-scoped `ingredients` table (child of `dishes`) with FORCE RLS, proven allow-same / deny-cross / cascade / composite-FK-integrity behavior via pgTAP, and regenerated TypeScript row types.

**Architecture:** Follows the ADR 0003 pattern used by every existing table: denormalized `household_id`, composite FK to `dishes (id, household_id)`, FORCE RLS with four direct `household_id = public.current_household_id()` policies. Test-first with pgTAP against an ephemeral Postgres (the required CI check).

**Tech Stack:** Supabase/Postgres migrations, pgTAP (`npx supabase test db --local`), Supabase type generation.

## Global Constraints

- **Design of record:** `docs/superpowers/specs/2026-07-22-recipe-ingest-design.md`, section "12b — `ingredients` table + RLS + pgTAP" — the DDL there is authoritative; copy it verbatim.
- **Pattern to mirror exactly:** `supabase/migrations/20260625164006_social_schema.sql` (the `dishes` table + its policies) and `supabase/tests/06_dishes_rls_test.sql` (the pgTAP style: one rolled-back transaction, inlined fixtures, `tests.authenticate_as` / `tests.clear_auth`).
- **Security posture (ADR 0003):** FORCE RLS on; identity via `public.current_household_id()`; denormalized `household_id`; NO service-role anywhere. `quantity numeric` (nullable), `unit` nullable, `raw_text NOT NULL`, `name` non-empty, `position` for ordering, `ON DELETE CASCADE` from the parent dish.
- **PREREQUISITE — local Supabase stack + Docker.** Unlike 12a/12z, this brick needs a running DB. Before Task 1: `npm run db:start` (starts local Supabase via `scripts/supabase.sh`). The pgTAP runner is `npx supabase test db --local`; it resets an ephemeral DB with all migrations, then runs `supabase/tests/*.sql`.
- Conventional commits (`feat:`), test-first, frequent commits. All changes route through a PR (branch protection); the "RLS pgTAP (Supabase)" CI check must pass.

## File Structure

- `supabase/tests/17_ingredients_rls_test.sql` — **create.** The failing-first pgTAP test.
- `supabase/migrations/<timestamp>_ingredients_schema.sql` — **create** (via `npm run db:migration ingredients_schema`; the tool stamps the timestamp). The table + RLS + policies.
- `lib/database.types.ts` — **regenerate** (adds the `ingredients` row types 12c consumes).

---

### Task 1: Failing pgTAP test for `ingredients` RLS

**Files:**
- Create: `supabase/tests/17_ingredients_rls_test.sql`

**Interfaces:**
- Produces: the acceptance gate for Task 2. Asserts RLS enabled+forced, allow-same/deny-cross for select/insert/update/delete, cascade-on-dish-delete, and composite-FK integrity.

- [ ] **Step 1: Ensure the local stack is up**

Run: `npm run db:start`
Expected: local Supabase running (Docker). If already running, this is a no-op.

- [ ] **Step 2: Write the test**

```sql
-- supabase/tests/17_ingredients_rls_test.sql
-- RLS: ingredients (dish child, household_id denormalized) — allow-same / deny-cross,
-- composite-FK integrity, and cascade-on-dish-delete.
--
-- pgTAP test (slice 1c, issue #12b). One rolled-back transaction; fixtures inlined
-- so the file is self-contained (matches 06_dishes_rls_test.sql).
begin;
select plan(11);

create schema if not exists tests;

insert into auth.users (id, instance_id, aud, role, email) values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'h-owner@test.local'),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'h-member@test.local'),
  ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'k-owner@test.local');

insert into public.households (id, name, owner_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Household H', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Household K', '33333333-3333-3333-3333-333333333333');

insert into public.members (id, household_id, user_id, display_name, role) values
  ('a0000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'H Owner', 'owner'),
  ('a0000002-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'H Member', 'member'),
  ('b0000001-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '33333333-3333-3333-3333-333333333333', 'K Owner', 'owner');

create or replace function tests.authenticate_as(p_user_id uuid) returns void language plpgsql as $fn$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user_id::text, 'role', 'authenticated')::text, true);
end; $fn$;

create or replace function tests.clear_auth() returns void language plpgsql as $fn$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', null, true);
end; $fn$;

grant usage on schema tests to authenticated;
grant execute on all functions in schema tests to authenticated;

-- ---- seed dishes + ingredients (privileged role: bypasses RLS) ----
insert into public.dishes (id, household_id, title, created_by) values
  ('0d000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'H Spaghetti', 'a0000001-0000-0000-0000-000000000001'),
  ('0d000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'K Tacos',     'b0000001-0000-0000-0000-000000000001');

insert into public.ingredients (id, household_id, dish_id, name, quantity, unit, raw_text, position) values
  ('01000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0d000001-0000-0000-0000-000000000001', 'spaghetti', 1, 'lb',  '1 lb spaghetti',   0),
  ('01000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '0d000002-0000-0000-0000-000000000002', 'tortillas', 8, null, '8 corn tortillas', 0);

-- 1-2: RLS enabled + FORCED
select is((select relrowsecurity   from pg_class where oid = 'public.ingredients'::regclass), true, 'ingredients has RLS enabled');
select is((select relforcerowsecurity from pg_class where oid = 'public.ingredients'::regclass), true, 'ingredients has RLS FORCEd (owner not exempt)');

-- 3: allow-same read
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');
select is((select count(*)::int from public.ingredients where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 1, 'allow-same: H member reads H''s ingredients');

-- 4: deny-cross read
select is((select count(*)::int from public.ingredients where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 0, 'deny-cross: H member cannot read K''s ingredients');

-- 5: allow-same insert into H's dish
insert into public.ingredients (household_id, dish_id, name, raw_text)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0d000001-0000-0000-0000-000000000001', 'garlic', '2 cloves garlic');
select is((select count(*)::int from public.ingredients where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 2, 'allow-same: H member inserts an ingredient into H');

-- 6: deny-cross insert (household K) blocked by the insert policy
select throws_ok(
  $$insert into public.ingredients (household_id, dish_id, name, raw_text) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '0d000002-0000-0000-0000-000000000002', 'pwned', 'pwned')$$,
  '42501', null, 'deny-cross: H member cannot insert an ingredient into K');

-- 7: allow-same update
update public.ingredients set name = 'spaghetti!' where id = '01000001-0000-0000-0000-000000000001';
select is((select name from public.ingredients where id = '01000001-0000-0000-0000-000000000001'), 'spaghetti!', 'allow-same: H member updates H''s ingredient');

-- 8: deny-cross update is a no-op under RLS; verify unchanged
update public.ingredients set name = 'pwned' where id = '01000002-0000-0000-0000-000000000002';
select tests.clear_auth();
select is((select name from public.ingredients where id = '01000002-0000-0000-0000-000000000002'), 'tortillas', 'deny-cross: H member cannot update K''s ingredient (unchanged)');

-- 9: allow-same delete
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');
delete from public.ingredients where id = '01000001-0000-0000-0000-000000000001';
select is((select count(*)::int from public.ingredients where id = '01000001-0000-0000-0000-000000000001'), 0, 'allow-same: H member deletes H''s ingredient');

-- 10: cascade — deleting the parent dish removes its ingredients
delete from public.dishes where id = '0d000001-0000-0000-0000-000000000001';
select is((select count(*)::int from public.ingredients where dish_id = '0d000001-0000-0000-0000-000000000001'), 0, 'cascade: deleting a dish removes its ingredients');

-- 11: composite-FK integrity — household_id must match the dish's household
select tests.clear_auth();
select throws_ok(
  $$insert into public.ingredients (household_id, dish_id, name, raw_text) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0d000002-0000-0000-0000-000000000002', 'mismatch', 'x')$$,
  '23503', null, 'integrity: ingredient (dish_id, household_id) must match a dish (composite FK)');

select * from finish();
rollback;
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx supabase test db --local`
Expected: FAIL — `17_ingredients_rls_test.sql` errors (relation `public.ingredients` does not exist). The existing tests (01–16) still pass.

- [ ] **Step 4: Commit the failing test**

```bash
git add supabase/tests/17_ingredients_rls_test.sql
git commit -m "test(db): pgTAP for ingredients RLS + cascade + composite FK (#12b)"
```

---

### Task 2: The `ingredients` migration

**Files:**
- Create: `supabase/migrations/<timestamp>_ingredients_schema.sql`

**Interfaces:**
- Consumes: `public.dishes (id, household_id)` (composite unique key), `public.current_household_id()` (existing SECURITY DEFINER helper).
- Produces: `public.ingredients` — the table 12c writes and 1d reads.

- [ ] **Step 1: Generate the migration file**

Run: `npm run db:migration ingredients_schema`
Expected: a new empty file `supabase/migrations/<timestamp>_ingredients_schema.sql`. Edit that file with the content in Step 2.

- [ ] **Step 2: Write the DDL (verbatim from the spec)**

```sql
-- ingredients — a dish's ingredient lines (issue #12b, Slice 1c). Child of dishes;
-- household_id denormalized (ADR 0003) + composite FK so an ingredient is always in
-- the same household as its dish. `raw_text` is always kept (nothing lost);
-- quantity/unit are nullable (count items, unparseable lines). ON DELETE CASCADE:
-- deleting a dish removes its ingredients.
create table public.ingredients (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  dish_id      uuid not null,
  name         text not null check (length(trim(name)) > 0),
  quantity     numeric,
  unit         text,
  raw_text     text not null,
  position     integer not null default 0,
  created_at   timestamptz not null default now(),
  foreign key (dish_id, household_id)
    references public.dishes (id, household_id) on delete cascade
);

create index ingredients_household_id_idx on public.ingredients (household_id);
create index ingredients_dish_id_idx      on public.ingredients (dish_id);

alter table public.ingredients enable row level security;
alter table public.ingredients force  row level security;

grant select, insert, update, delete on public.ingredients to authenticated;

-- Every ingredient is shared household data: any authenticated member of the
-- household may read/write its rows. Direct household_id check (ADR 0003 — no
-- parent join). UPDATE repeats the check in WITH CHECK so a row can't be moved
-- to another household.
create policy ingredients_select on public.ingredients
  for select to authenticated
  using (household_id = public.current_household_id());
create policy ingredients_insert on public.ingredients
  for insert to authenticated
  with check (household_id = public.current_household_id());
create policy ingredients_update on public.ingredients
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());
create policy ingredients_delete on public.ingredients
  for delete to authenticated
  using (household_id = public.current_household_id());
```

- [ ] **Step 3: Run the pgTAP suite to verify it passes**

Run: `npx supabase test db --local`
Expected: PASS — `17_ingredients_rls_test.sql` reports `ok 1..11`, and all existing tests (01–16) still pass.

- [ ] **Step 4: Commit the migration**

```bash
git add supabase/migrations
git commit -m "feat(db): ingredients table with FORCE RLS + composite FK to dishes (#12b)"
```

---

### Task 3: Regenerate TypeScript row types

**Files:**
- Modify: `lib/database.types.ts`

**Interfaces:**
- Produces: the `ingredients` `Row`/`Insert`/`Update` types that 12c's ingest action uses (typed Supabase client).

- [ ] **Step 1: Apply the new migration to the local DB**

Run: `npm run db:reset`
Expected: local DB reset with all migrations, including `ingredients`.

- [ ] **Step 2: Regenerate types**

Run: `npm run db:types`
Expected: `lib/database.types.ts` rewritten; it now contains an `ingredients` table entry with the columns from Task 2 (`id, household_id, dish_id, name, quantity, unit, raw_text, position, created_at`).

- [ ] **Step 3: Verify typecheck is clean**

Run: `npx tsc --noEmit`
Expected: clean (the regenerated types compile; nothing yet consumes `ingredients`, so no breakage).

- [ ] **Step 4: Commit**

```bash
git add lib/database.types.ts
git commit -m "chore(db): regenerate types for the ingredients table (#12b)"
```

---

## Self-Review

**1. Spec coverage (12b):** ✅ table shape (denormalized `household_id`, composite FK, `quantity numeric` nullable, `unit` nullable, `raw_text` NOT NULL, `position`, cascade) → Task 2 DDL; FORCE RLS + four `current_household_id()` policies → Task 2; pgTAP coverage (RLS on/forced, same-household CRUD, cross-household deny, cascade-on-dish-delete, composite-FK integrity) → Task 1 (11 assertions); types for 12c → Task 3.

**2. Placeholder scan:** none — the only non-literal is the migration timestamp, which is generated by `npm run db:migration` (Step 1 of Task 2 makes that explicit).

**3. Type/pattern consistency:** the pgTAP fixtures + `tests.authenticate_as`/`clear_auth` mirror `06_dishes_rls_test.sql`; the DDL mirrors the `dishes` block of `20260625164006_social_schema.sql`; policies use the exact `public.current_household_id()` helper every other table uses. Column names in the test seed (`name, quantity, unit, raw_text, position`) match the DDL columns.
