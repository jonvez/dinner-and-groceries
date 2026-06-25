-- RLS: dishes (reusable library, household_id direct) — allow-same / deny-cross.
--
-- pgTAP test (slice 1b, issue #7). One rolled-back transaction; fixtures inlined
-- so the file is self-contained (matches the 1a test style, 01..05_*).
begin;
select plan(8);

create schema if not exists tests;

insert into auth.users (id, instance_id, aud, role, email) values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'h-owner@test.local'),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'h-member@test.local'),
  ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'k-owner@test.local'),
  ('44444444-4444-4444-4444-444444444444', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'k-member@test.local');

insert into public.households (id, name, owner_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Household H', '11111111-1111-1111-1111-111111111111'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Household K', '33333333-3333-3333-3333-333333333333');

insert into public.members (id, household_id, user_id, display_name, role) values
  ('a0000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'H Owner', 'owner'),
  ('a0000002-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'H Member', 'member'),
  ('b0000001-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '33333333-3333-3333-3333-333333333333', 'K Owner', 'owner'),
  ('b0000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '44444444-4444-4444-4444-444444444444', 'K Member', 'member');

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

-- ---- seed dishes (privileged role: bypasses RLS) ----
insert into public.dishes (id, household_id, title, created_by) values
  ('0d000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'H Spaghetti', 'a0000001-0000-0000-0000-000000000001'),
  ('0d000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'K Tacos',     'b0000001-0000-0000-0000-000000000001');

select is(
  (select relrowsecurity from pg_class where oid = 'public.dishes'::regclass),
  true, 'dishes has RLS enabled'
);
select is(
  (select relforcerowsecurity from pg_class where oid = 'public.dishes'::regclass),
  true, 'dishes has RLS FORCEd (owner not exempt)'
);

-- ---- allow-same: H member reads H's dishes ----
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');
select is(
  (select count(*)::int from public.dishes where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1, 'allow-same: H member can read H''s dishes'
);

-- ---- deny-cross: H member cannot read K's dishes ----
select is(
  (select count(*)::int from public.dishes where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  0, 'deny-cross: H member cannot read K''s dishes'
);

-- ---- allow-same: H member can add a dish to H (tags[] free-text) ----
insert into public.dishes (household_id, title, tags, created_by)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'H Salad', array['veg-forward','quick'], 'a0000002-0000-0000-0000-000000000002');
select is(
  (select count(*)::int from public.dishes where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  2, 'allow-same: H member can insert a dish into H'
);

-- ---- deny-cross: H member cannot insert a dish into K ----
select throws_ok(
  $$insert into public.dishes (household_id, title) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'pwned')$$,
  '42501', null, 'deny-cross: H member cannot insert a dish into K'
);

-- ---- allow-same: H member can update H's dish ----
update public.dishes set title = 'H Spaghetti!' where id = '0d000001-0000-0000-0000-000000000001';
select is(
  (select title from public.dishes where id = '0d000001-0000-0000-0000-000000000001'),
  'H Spaghetti!', 'allow-same: H member can update H''s dish'
);

-- ---- deny-cross: H member cannot update K's dish ----
update public.dishes set title = 'pwned' where id = '0d000002-0000-0000-0000-000000000002';
select tests.clear_auth();
select is(
  (select title from public.dishes where id = '0d000002-0000-0000-0000-000000000002'),
  'K Tacos', 'deny-cross: H member cannot update K''s dish (row unchanged)'
);

select * from finish();
rollback;
