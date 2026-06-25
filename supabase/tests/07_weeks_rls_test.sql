-- RLS + integrity: weeks (household_id direct) — allow-same / deny-cross and
-- the UNIQUE(household_id, start_date) constraint (ADR 0003: lazy week upsert).
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

-- ---- seed one week per household (privileged role: bypasses RLS) ----
insert into public.weeks (id, household_id, start_date) values
  ('0e000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-06-22'),
  ('0e000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', date '2026-06-22');

select is(
  (select relrowsecurity from pg_class where oid = 'public.weeks'::regclass),
  true, 'weeks has RLS enabled'
);
select is(
  (select relforcerowsecurity from pg_class where oid = 'public.weeks'::regclass),
  true, 'weeks has RLS FORCEd (owner not exempt)'
);

-- ---- allow-same: H member reads H's week ----
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');
select is(
  (select count(*)::int from public.weeks where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1, 'allow-same: H member can read H''s week'
);

-- ---- deny-cross: H member cannot read K's week ----
select is(
  (select count(*)::int from public.weeks where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  0, 'deny-cross: H member cannot read K''s week'
);

-- ---- allow-same: H member can open (insert) a new week ----
insert into public.weeks (household_id, start_date)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-06-29');
select is(
  (select count(*)::int from public.weeks where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  2, 'allow-same: H member can open a new week'
);

-- ---- constraint: UNIQUE(household_id, start_date) — one week row per start ----
-- (idempotent lazy upsert: a duplicate (household, start_date) is rejected.)
select throws_ok(
  $$insert into public.weeks (household_id, start_date)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-06-22')$$,
  '23505', null, 'constraint: a duplicate (household_id, start_date) week is rejected'
);

-- ---- constraint: the SAME start_date in a DIFFERENT household IS allowed ----
-- Uniqueness is scoped per household, not global. H and K were BOTH seeded a
-- week on 2026-06-22; if the constraint were global the second seed would have
-- failed. Verify under the privileged role (clear_auth) so we can see across
-- households, then re-authenticate as the H member for the final check.
select tests.clear_auth();
select is(
  (select count(*)::int from public.weeks where start_date = date '2026-06-22'),
  2, 'constraint: the same start_date coexists across two households (per-household uniqueness)'
);
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');

-- ---- deny-cross: H member cannot open a week in K ----
select throws_ok(
  $$insert into public.weeks (household_id, start_date)
    values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', date '2026-07-13')$$,
  '42501', null, 'deny-cross: H member cannot open a week in K'
);
select tests.clear_auth();

select * from finish();
rollback;
