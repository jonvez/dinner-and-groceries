-- RLS: comments (discussion on a proposal; household_id DENORMALIZED per
-- ADR 0003) — allow-same / deny-cross via a direct household_id check.
--
-- pgTAP test (slice 1b, issue #7). One rolled-back transaction; fixtures inlined.
begin;
select plan(6);

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

-- ---- seed week/dish/proposal for both households + one H comment ----
insert into public.weeks (id, household_id, start_date) values
  ('0e000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-06-22'),
  ('0e000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', date '2026-06-22');
insert into public.dishes (id, household_id, title) values
  ('0d000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'H Spaghetti'),
  ('0d000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'K Tacos');
insert into public.proposals (id, household_id, week_id, dish_id) values
  ('90000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0e000001-0000-0000-0000-000000000001', '0d000001-0000-0000-0000-000000000001'),
  ('90000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '0e000002-0000-0000-0000-000000000002', '0d000002-0000-0000-0000-000000000002');
insert into public.comments (id, household_id, proposal_id, member_id, body) values
  ('c0000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '90000001-0000-0000-0000-000000000001', 'a0000001-0000-0000-0000-000000000001', 'yum'),
  ('c0000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '90000002-0000-0000-0000-000000000002', 'b0000001-0000-0000-0000-000000000001', 'spicy?');

select is(
  (select relrowsecurity from pg_class where oid = 'public.comments'::regclass),
  true, 'comments has RLS enabled'
);
select is(
  (select relforcerowsecurity from pg_class where oid = 'public.comments'::regclass),
  true, 'comments has RLS FORCEd (owner not exempt)'
);

-- ---- allow-same: H member reads H's comment ----
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');
select is(
  (select count(*)::int from public.comments where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1, 'allow-same: H member can read H''s comment'
);

-- ---- deny-cross: H member cannot read K's comment ----
select is(
  (select count(*)::int from public.comments where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  0, 'deny-cross: H member cannot read K''s comment'
);

-- ---- allow-same: H member can comment on an H proposal ----
insert into public.comments (household_id, proposal_id, member_id, body)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '90000001-0000-0000-0000-000000000001', 'a0000002-0000-0000-0000-000000000002', 'love it');
select is(
  (select count(*)::int from public.comments where proposal_id = '90000001-0000-0000-0000-000000000001'),
  2, 'allow-same: H member can comment on an H proposal'
);

-- ---- deny-cross: H member cannot comment tagged to K ----
select throws_ok(
  $$insert into public.comments (household_id, proposal_id, member_id, body)
    values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '90000002-0000-0000-0000-000000000002', 'a0000002-0000-0000-0000-000000000002', 'pwned')$$,
  '42501', null, 'deny-cross: H member cannot comment into K'
);
select tests.clear_auth();

select * from finish();
rollback;
