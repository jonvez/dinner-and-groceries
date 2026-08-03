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
