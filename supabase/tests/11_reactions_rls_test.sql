-- RLS + integrity: reactions (social signal on a proposal; household_id
-- DENORMALIZED per ADR 0003). UNIQUE(proposal_id, member_id, kind) makes a
-- reaction toggle idempotent (ADR 0003 "optimistic writes").
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

-- ---- seed week/dish/proposal for both households + one H reaction ----
insert into public.weeks (id, household_id, start_date) values
  ('0e000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-06-22'),
  ('0e000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', date '2026-06-22');
insert into public.dishes (id, household_id, title) values
  ('0d000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'H Spaghetti'),
  ('0d000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'K Tacos');
insert into public.proposals (id, household_id, week_id, dish_id) values
  ('90000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0e000001-0000-0000-0000-000000000001', '0d000001-0000-0000-0000-000000000001'),
  ('90000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '0e000002-0000-0000-0000-000000000002', '0d000002-0000-0000-0000-000000000002');
insert into public.reactions (id, household_id, proposal_id, member_id, kind) values
  ('ac000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '90000001-0000-0000-0000-000000000001', 'a0000002-0000-0000-0000-000000000002', '👍'),
  ('ac000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '90000002-0000-0000-0000-000000000002', 'b0000002-0000-0000-0000-000000000002', '👍');

select is(
  (select relrowsecurity from pg_class where oid = 'public.reactions'::regclass),
  true, 'reactions has RLS enabled'
);
select is(
  (select relforcerowsecurity from pg_class where oid = 'public.reactions'::regclass),
  true, 'reactions has RLS FORCEd (owner not exempt)'
);

-- ---- allow-same: H member reads H's reaction ----
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');
select is(
  (select count(*)::int from public.reactions where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1, 'allow-same: H member can read H''s reaction'
);

-- ---- deny-cross: H member cannot read K's reaction ----
select is(
  (select count(*)::int from public.reactions where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  0, 'deny-cross: H member cannot read K''s reaction'
);

-- ---- integrity: the SAME (proposal, member, kind) is rejected (idempotent toggle) ----
select throws_ok(
  $$insert into public.reactions (household_id, proposal_id, member_id, kind)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '90000001-0000-0000-0000-000000000001', 'a0000002-0000-0000-0000-000000000002', '👍')$$,
  '23505', null, 'integrity: duplicate (proposal, member, kind) reaction rejected (idempotent toggle)'
);

-- ---- allow-same: a DIFFERENT kind from the same member on the same proposal is allowed ----
insert into public.reactions (household_id, proposal_id, member_id, kind)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '90000001-0000-0000-0000-000000000001', 'a0000002-0000-0000-0000-000000000002', '🎉');
select is(
  (select count(*)::int from public.reactions where proposal_id = '90000001-0000-0000-0000-000000000001'),
  2, 'allow-same: a different kind by the same member on the same proposal is allowed'
);

-- ---- allow-same: H member can remove (toggle off) their reaction ----
delete from public.reactions where id = 'ac000001-0000-0000-0000-000000000001';
select is(
  (select count(*)::int from public.reactions where id = 'ac000001-0000-0000-0000-000000000001'),
  0, 'allow-same: H member can remove a reaction in H'
);

-- ---- deny-cross: H member cannot react on a K proposal (tagged to K) ----
select throws_ok(
  $$insert into public.reactions (household_id, proposal_id, member_id, kind)
    values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '90000002-0000-0000-0000-000000000002', 'a0000002-0000-0000-0000-000000000002', '👍')$$,
  '42501', null, 'deny-cross: H member cannot react into K'
);
select tests.clear_auth();

select * from finish();
rollback;
