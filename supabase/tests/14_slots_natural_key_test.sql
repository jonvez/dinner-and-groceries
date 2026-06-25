-- slots NATURAL KEY (issue #10): unique (week_id, day_of_week, meal_type) makes
-- "find-or-create the slot" idempotent, and the find-or-create UPSERT works for
-- an authenticated household member UNDER force-RLS (the ON CONFLICT DO UPDATE
-- branch must satisfy the slots UPDATE policy). Also: a plain duplicate
-- natural-key insert raises 23505.
--
-- pgTAP test (slice 1b, issue #10). One rolled-back transaction; fixtures inlined
-- (mirrors 08_slots_rls_test.sql).
begin;
select plan(5);

create schema if not exists tests;

insert into auth.users (id, instance_id, aud, role, email) values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'h-owner@test.local'),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'h-member@test.local');

insert into public.households (id, name, owner_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Household H', '11111111-1111-1111-1111-111111111111');

insert into public.members (id, household_id, user_id, display_name, role) values
  ('a0000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'H Owner', 'owner'),
  ('a0000002-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'H Member', 'member');

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

-- A week to slot into (privileged role: bypasses RLS for fixture setup).
insert into public.weeks (id, household_id, start_date) values
  ('0e000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-06-22');

-- A temp table to capture the id returned by each upsert (created + granted as
-- the privileged role, before switching to the authenticated member below).
create temp table _slot_ids (n int primary key, id uuid);
grant insert, select on _slot_ids to authenticated;

-- ---- 1) the natural key is unique ----
select col_is_unique(
  'public'::name, 'slots'::name,
  ARRAY['week_id', 'day_of_week', 'meal_type']::name[],
  'slots has a UNIQUE natural key (week_id, day_of_week, meal_type)'
);

-- The actor is a legitimate H member acting within their own household. Their
-- two taps below mirror supabase-js .upsert(..., {onConflict: natural key}).
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');

-- First tap: no conflict -> INSERT path (must pass the INSERT WITH CHECK policy).
with up1 as (
  insert into public.slots (household_id, week_id, meal_type, day_of_week)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0e000001-0000-0000-0000-000000000001', 'dinner', 3)
  on conflict (week_id, day_of_week, meal_type)
  do update set household_id = excluded.household_id, day_of_week = excluded.day_of_week
  returning id
)
insert into _slot_ids select 1, id from up1;

-- Second tap, SAME natural key: conflict -> DO UPDATE path. This is the RLS
-- moment of truth — the UPDATE using + with check on the existing same-household
-- row must pass for find-or-create to be idempotent.
with up2 as (
  insert into public.slots (household_id, week_id, meal_type, day_of_week)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0e000001-0000-0000-0000-000000000001', 'dinner', 3)
  on conflict (week_id, day_of_week, meal_type)
  do update set household_id = excluded.household_id, day_of_week = excluded.day_of_week
  returning id
)
insert into _slot_ids select 2, id from up2;

-- ---- 2) idempotent: exactly ONE slot for that cell after two upserts ----
select is(
  (select count(*)::int from public.slots
     where week_id = '0e000001-0000-0000-0000-000000000001'
       and day_of_week = 3 and meal_type = 'dinner'),
  1, 'find-or-create is idempotent: two upserts -> exactly one slot row'
);

-- ---- 3) the second upsert returned the SAME slot id (a no-op create) ----
select is(
  (select id from _slot_ids where n = 2),
  (select id from _slot_ids where n = 1),
  'second upsert returns the SAME slot id (found, not re-created)'
);

-- ---- 4) the upsert actually wrote a row under RLS (sanity on the INSERT path) ----
select isnt(
  (select id from _slot_ids where n = 1),
  null,
  'find-or-create upsert works under force-RLS for an authenticated member'
);

-- ---- 5) a plain duplicate natural-key insert raises unique_violation (23505) ----
select throws_ok(
  $$insert into public.slots (household_id, week_id, meal_type, day_of_week)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0e000001-0000-0000-0000-000000000001', 'dinner', 3)$$,
  '23505', null, 'duplicate natural-key slot insert raises unique_violation'
);

select tests.clear_auth();

select * from finish();
rollback;
