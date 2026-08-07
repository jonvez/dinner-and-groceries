-- RLS: grocery_items (per-week shopping list, child of weeks, household_id
-- denormalized) — allow-same / deny-cross, optional quantity/unit, blank-name guard.
--
-- pgTAP test (slice 1d, issue #13). One rolled-back transaction; fixtures inlined
-- so the file is self-contained (matches 17_ingredients_rls_test.sql).
begin;
select plan(7);

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

-- ---- seed a week + a list row per household (privileged role: bypasses RLS) ----
insert into public.weeks (id, household_id, start_date) values
  ('0e000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2026-08-03'),
  ('0e000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '2026-08-03');

-- Ad-hoc rows (no ingredient_id / catalog_item_id) with quantity+unit NULL.
insert into public.grocery_items (id, household_id, week_id, name) values
  ('09000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0e000001-0000-0000-0000-000000000001', 'paper towels'),
  ('09000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '0e000002-0000-0000-0000-000000000002', 'dish soap');

-- 1-2: RLS enabled + FORCED
select is((select relrowsecurity      from pg_class where oid = 'public.grocery_items'::regclass), true, 'grocery_items has RLS enabled');
select is((select relforcerowsecurity from pg_class where oid = 'public.grocery_items'::regclass), true, 'grocery_items has RLS FORCEd (owner not exempt)');

-- 3: allow-same read
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');
select is((select count(*)::int from public.grocery_items where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 1, 'allow-same: H member reads H''s grocery items');

-- 4: deny-cross read
select is((select count(*)::int from public.grocery_items where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 0, 'deny-cross: H member cannot read K''s grocery items');

-- 5: deny-cross insert (K's household + K's week) blocked by the insert policy
select throws_ok(
  $$insert into public.grocery_items (household_id, week_id, name) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '0e000002-0000-0000-0000-000000000002', 'pwned')$$,
  '42501', null, 'deny-cross: H member cannot insert a grocery item into K');

-- 6: allow-same insert with quantity and unit NULL (both are optional)
select lives_ok(
  $$insert into public.grocery_items (household_id, week_id, name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0e000001-0000-0000-0000-000000000001', 'bananas')$$,
  'allow-same: H member inserts an ad-hoc grocery item with quantity/unit NULL');

-- 7: blank name rejected by the check constraint
select throws_ok(
  $$insert into public.grocery_items (household_id, week_id, name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0e000001-0000-0000-0000-000000000001', '   ')$$,
  '23514', null, 'integrity: a blank grocery item name is rejected');

select * from finish();
rollback;
