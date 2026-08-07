-- RLS: catalog_items (reusable staples, top-level household child) — allow-same /
-- deny-cross reads and writes.
--
-- pgTAP test (slice 1d, issue #13). One rolled-back transaction; fixtures inlined
-- so the file is self-contained (matches 17_ingredients_rls_test.sql).
begin;
select plan(8);

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

-- ---- seed one staple per household (privileged role: bypasses RLS) ----
insert into public.catalog_items (id, household_id, name, default_unit, category) values
  ('c1000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'milk',   'gal', 'dairy'),
  ('c1000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'coffee', 'bag', 'pantry');

-- 1-2: RLS enabled + FORCED
select is((select relrowsecurity      from pg_class where oid = 'public.catalog_items'::regclass), true, 'catalog_items has RLS enabled');
select is((select relforcerowsecurity from pg_class where oid = 'public.catalog_items'::regclass), true, 'catalog_items has RLS FORCEd (owner not exempt)');

-- 3: allow-same read
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');
select is((select count(*)::int from public.catalog_items where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 1, 'allow-same: H member reads H''s catalog items');

-- 4: deny-cross read
select is((select count(*)::int from public.catalog_items where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 0, 'deny-cross: H member cannot read K''s catalog items');

-- 5: deny-cross insert blocked by the insert policy
select throws_ok(
  $$insert into public.catalog_items (household_id, name) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'pwned')$$,
  '42501', null, 'deny-cross: H member cannot insert a catalog item into K');

-- 6: allow-same insert
select lives_ok(
  $$insert into public.catalog_items (household_id, name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'olive oil')$$,
  'allow-same: H member inserts a catalog item into H');

-- 7: allow-same update — the UPDATE policy's USING clause lets H's own rows through
update public.catalog_items set category = 'x' where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
select is((select bool_and(category = 'x') from public.catalog_items where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  true, 'allow-same: H member''s UPDATE actually changes H''s catalog rows');

-- 8: deny-cross update — WITH CHECK blocks re-homing a row into another household
select throws_ok(
  $$update public.catalog_items set household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$,
  '42501', null, 'with check blocks re-homing a catalog row');

select * from finish();
rollback;
