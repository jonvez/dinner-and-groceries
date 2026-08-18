-- RLS + integrity: grocery_sections (aisle grouping for the shopping list) —
-- allow-same / deny-cross reads and writes, the cross-household pointer being
-- unstorable, the default-section seeding trigger, and the grant posture for a
-- newly created public table.
--
-- pgTAP test (epic #135, issue #136). One rolled-back transaction; fixtures
-- inlined so the file is self-contained (matches 18_catalog_items_rls_test.sql).
begin;
select plan(12);

create schema if not exists tests;

insert into auth.users (id, instance_id, aud, role, email) values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'h-owner@test.local'),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'h-member@test.local'),
  ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'k-owner@test.local');

-- The AFTER INSERT trigger seeds each of these with the default sections.
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

-- A staple in each household, for the pointer-integrity checks below.
insert into public.catalog_items (id, household_id, name) values
  ('c1000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'milk'),
  ('c1000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'coffee');

-- 1-2: RLS enabled + FORCED
select is((select relrowsecurity      from pg_class where oid = 'public.grocery_sections'::regclass), true, 'grocery_sections has RLS enabled');
select is((select relforcerowsecurity from pg_class where oid = 'public.grocery_sections'::regclass), true, 'grocery_sections has RLS FORCEd (owner not exempt)');

-- 3: the AFTER INSERT trigger seeded defaults for a brand-new household
select is(
  (select count(*)::int from public.grocery_sections where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  (select count(*)::int from public.default_grocery_sections()),
  'creating a household seeds the default sections');

-- 4: Unsorted sorts last, so uncategorized items collect at the bottom
select is(
  (select name from public.grocery_sections
   where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' order by position desc limit 1),
  'Unsorted', 'Unsorted has the highest position (sorts last)');

-- ---- RLS, as an H member ----
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');

-- 5: allow-same read
select ok(
  (select count(*) from public.grocery_sections where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') > 0,
  'allow-same: H member reads H''s sections');

-- 6: deny-cross read
select is((select count(*)::int from public.grocery_sections where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 0,
  'deny-cross: H member cannot read K''s sections');

-- 7: deny-cross insert
select throws_ok(
  $$insert into public.grocery_sections (household_id, name, position) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'pwned', 1)$$,
  '42501', null, 'deny-cross: H member cannot insert a section into K');

-- 8: allow-same insert
select lives_ok(
  $$insert into public.grocery_sections (household_id, name, position) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Bulk Bins', 65)$$,
  'allow-same: H member inserts a section into H');

-- 9: allow-same update (reordering is the whole point of `position`)
update public.grocery_sections set position = 999
  where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and name = 'Bulk Bins';
select is(
  (select position from public.grocery_sections
   where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and name = 'Bulk Bins'),
  999, 'allow-same: H member reorders H''s own section');

-- 10: deny-cross update — WITH CHECK blocks re-homing a section
select throws_ok(
  $$update public.grocery_sections set household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'$$,
  '42501', null, 'with check blocks re-homing a section');

-- 11: a cross-household section pointer is UNSTORABLE, not merely unreadable.
-- The composite (section_id, household_id) FK has no matching row when the
-- section belongs to K and the catalog item belongs to H, so this is a foreign
-- key violation (23503) rather than an RLS denial.
select tests.clear_auth();
select throws_ok(
  format(
    $$update public.catalog_items set section_id = %L where id = 'c1000001-0000-0000-0000-000000000001'$$,
    (select id from public.grocery_sections where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' limit 1)
  ),
  '23503', null, 'a catalog item cannot point at another household''s section');

-- 12: the new table did not inherit Supabase's default TRUNCATE grant (#49 —
-- TRUNCATE bypasses RLS and is a bulk delete). Every new public table has to
-- revoke this explicitly; `alter default privileges` was left out of scope there.
select ok(
  NOT has_table_privilege('authenticated', 'public.grocery_sections', 'TRUNCATE'),
  'authenticated cannot TRUNCATE public.grocery_sections');

select * from finish();
rollback;
