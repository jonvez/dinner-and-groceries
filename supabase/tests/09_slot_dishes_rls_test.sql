-- RLS + modeling: slot_dishes (composes MANY dishes into one slot; household_id
-- DENORMALIZED per ADR 0003; reserved prep_minutes_override column, no UI).
--
-- pgTAP test (slice 1b, issue #7). One rolled-back transaction; fixtures inlined.
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

-- ---- seed week, slot, two dishes for H + one of each for K ----
insert into public.weeks (id, household_id, start_date) values
  ('0e000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-06-22'),
  ('0e000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', date '2026-06-22');

insert into public.slots (id, household_id, week_id, meal_type, day_of_week, position) values
  ('05000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0e000001-0000-0000-0000-000000000001', 'dinner', 2, 0),
  ('05000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '0e000002-0000-0000-0000-000000000002', 'dinner', 2, 0);

insert into public.dishes (id, household_id, title) values
  ('0d000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'H Spaghetti'),
  ('0d000003-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'H Salad'),
  ('0d000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'K Tacos');

-- One dish already slotted in H's dinner (spaghetti).
insert into public.slot_dishes (id, household_id, slot_id, dish_id, position) values
  ('5d000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '05000001-0000-0000-0000-000000000001', '0d000001-0000-0000-0000-000000000001', 0);
insert into public.slot_dishes (id, household_id, slot_id, dish_id, position) values
  ('5d000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '05000002-0000-0000-0000-000000000002', '0d000002-0000-0000-0000-000000000002', 0);

select is(
  (select relrowsecurity from pg_class where oid = 'public.slot_dishes'::regclass),
  true, 'slot_dishes has RLS enabled'
);
select is(
  (select relforcerowsecurity from pg_class where oid = 'public.slot_dishes'::regclass),
  true, 'slot_dishes has RLS FORCEd (owner not exempt)'
);

-- ---- modeling: prep_minutes_override exists and is nullable (reserved, no UI) ----
select col_is_null('public', 'slot_dishes', 'prep_minutes_override',
  'modeling: slot_dishes.prep_minutes_override is reserved + nullable (no UI)');

-- ---- allow-same: H member reads H's slotted dish ----
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');
select is(
  (select count(*)::int from public.slot_dishes where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1, 'allow-same: H member can read H''s slotted dish'
);

-- ---- deny-cross: H member cannot read K's slotted dish ----
select is(
  (select count(*)::int from public.slot_dishes where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  0, 'deny-cross: H member cannot read K''s slotted dish'
);

-- ---- modeling: a slot holds MANY dishes (add salad to the same dinner slot) ----
insert into public.slot_dishes (household_id, slot_id, dish_id, position)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '05000001-0000-0000-0000-000000000001', '0d000003-0000-0000-0000-000000000003', 1);
select is(
  (select count(*)::int from public.slot_dishes where slot_id = '05000001-0000-0000-0000-000000000001'),
  2, 'modeling: one slot holds many dishes (spaghetti + salad)'
);

-- ---- allow-same: H member can unslot a dish from H ----
delete from public.slot_dishes where id = '5d000001-0000-0000-0000-000000000001';
select is(
  (select count(*)::int from public.slot_dishes where id = '5d000001-0000-0000-0000-000000000001'),
  0, 'allow-same: H member can unslot (delete) a dish in H'
);

-- ---- deny-cross: H member cannot insert a slot_dish tagged to K ----
select throws_ok(
  $$insert into public.slot_dishes (household_id, slot_id, dish_id, position)
    values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '05000002-0000-0000-0000-000000000002', '0d000002-0000-0000-0000-000000000002', 1)$$,
  '42501', null, 'deny-cross: H member cannot slot a dish into K'
);
select tests.clear_auth();

select * from finish();
rollback;
