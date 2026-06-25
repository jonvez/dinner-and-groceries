-- Cross-household INTEGRITY: the composite (parent_id, household_id) FKs and the
-- composite attribution FKs are the keystone that keeps the DENORMALIZED
-- household_id honest (ADR 0003). The 06..12 deny-cross tests all set
-- household_id = K, so they trip the RLS WITH CHECK (42501) BEFORE the FK is
-- ever reached — leaving the composite FKs unverified. This file exercises them
-- directly: every insert below sets household_id = the caller's OWN household
-- (so it PASSES the RLS WITH CHECK) but points a FK at ANOTHER household's row,
-- so the only thing that can reject it is the composite FK (23503).
--
-- Also covers: a move-to-another-household UPDATE is denied by RLS (42501), and
-- (in 07_weeks) that the per-household weeks uniqueness genuinely allows the
-- same start_date in different households.
--
-- pgTAP test (slice 1b, issue #7). One rolled-back transaction; fixtures inlined.
begin;
select plan(10);

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

-- ---- seed a parallel set of rows in BOTH households (privileged: bypass RLS) ----
insert into public.weeks (id, household_id, start_date) values
  ('0e000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', date '2026-06-22'),
  ('0e000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', date '2026-06-22');
insert into public.dishes (id, household_id, title) values
  ('0d000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'H Spaghetti'),
  ('0d000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'K Tacos');
insert into public.slots (id, household_id, week_id, meal_type, day_of_week, position) values
  ('05000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0e000001-0000-0000-0000-000000000001', 'dinner', 2, 0),
  ('05000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '0e000002-0000-0000-0000-000000000002', 'dinner', 2, 0);
insert into public.proposals (id, household_id, week_id, dish_id) values
  ('90000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0e000001-0000-0000-0000-000000000001', '0d000001-0000-0000-0000-000000000001'),
  ('90000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '0e000002-0000-0000-0000-000000000002', '0d000002-0000-0000-0000-000000000002');

-- The attacker is a legitimate H member acting only within their own household_id.
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');

-- ===========================================================================
-- Part A — composite PARENT FK: own household_id (passes RLS) + a parent row in
-- ANOTHER household => composite (parent_id, household_id) FK violation (23503).
-- ===========================================================================

-- slots -> weeks
select throws_ok(
  $$insert into public.slots (household_id, week_id, meal_type, day_of_week, position)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0e000002-0000-0000-0000-000000000002', 'dinner', 3, 0)$$,
  '23503', null, 'FK: slot in H cannot reference K''s week (composite parent FK blocks it)'
);

-- slot_dishes -> slots (dish_id is a valid H dish, so only the slot FK can fail)
select throws_ok(
  $$insert into public.slot_dishes (household_id, slot_id, dish_id, position)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '05000002-0000-0000-0000-000000000002', '0d000001-0000-0000-0000-000000000001', 0)$$,
  '23503', null, 'FK: slot_dish in H cannot reference K''s slot (composite parent FK blocks it)'
);

-- proposals -> weeks (dish_id is a valid H dish, so only the week FK can fail)
select throws_ok(
  $$insert into public.proposals (household_id, week_id, dish_id)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0e000002-0000-0000-0000-000000000002', '0d000001-0000-0000-0000-000000000001')$$,
  '23503', null, 'FK: proposal in H cannot reference K''s week (composite parent FK blocks it)'
);

-- reactions -> proposals (member_id is a valid H member, so only the proposal FK can fail)
select throws_ok(
  $$insert into public.reactions (household_id, proposal_id, member_id, kind)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '90000002-0000-0000-0000-000000000002', 'a0000002-0000-0000-0000-000000000002', '👍')$$,
  '23503', null, 'FK: reaction in H cannot reference K''s proposal (composite parent FK blocks it)'
);

-- comments -> proposals (member_id is a valid H member, so only the proposal FK can fail)
select throws_ok(
  $$insert into public.comments (household_id, proposal_id, member_id, body)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '90000002-0000-0000-0000-000000000002', 'a0000002-0000-0000-0000-000000000002', 'sneaky')$$,
  '23503', null, 'FK: comment in H cannot reference K''s proposal (composite parent FK blocks it)'
);

-- ===========================================================================
-- Part B — composite ATTRIBUTION FK: own household_id + a valid same-household
-- parent, but the attribution column points at a member of ANOTHER household
-- => composite (col, household_id) -> members(id, household_id) violation (23503).
-- (Parity with reactions.member_id; closes the LOW review finding.)
-- ===========================================================================

-- dishes.created_by -> members
select throws_ok(
  $$insert into public.dishes (household_id, title, created_by)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'forged', 'b0000002-0000-0000-0000-000000000002')$$,
  '23503', null, 'FK: dish.created_by cannot be a K member (composite attribution FK blocks it)'
);

-- proposals.proposed_by -> members (week + dish are valid H rows)
select throws_ok(
  $$insert into public.proposals (household_id, week_id, dish_id, proposed_by)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0e000001-0000-0000-0000-000000000001', '0d000001-0000-0000-0000-000000000001', 'b0000002-0000-0000-0000-000000000002')$$,
  '23503', null, 'FK: proposal.proposed_by cannot be a K member (composite attribution FK blocks it)'
);

-- comments.member_id -> members (proposal is a valid H row)
select throws_ok(
  $$insert into public.comments (household_id, proposal_id, member_id, body)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '90000001-0000-0000-0000-000000000001', 'b0000002-0000-0000-0000-000000000002', 'forged author')$$,
  '23503', null, 'FK: comment.member_id cannot be a K member (composite attribution FK blocks it)'
);

-- ===========================================================================
-- Part C — move-to-another-household UPDATE is denied by RLS (42501). Tested on
-- the TOP-LEVEL tables (weeks, dishes) so the rejection is unambiguously the RLS
-- WITH CHECK (no parent FK to also trip). The USING clause still matches the row
-- (it is in H); the WITH CHECK rejects the new household_id = K.
-- ===========================================================================

-- weeks: cannot move an H week into K
select throws_ok(
  $$update public.weeks set household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    where id = '0e000001-0000-0000-0000-000000000001'$$,
  '42501', null, 'move: H member cannot UPDATE an H week into K (RLS WITH CHECK)'
);

-- dishes: cannot move an H dish into K
select throws_ok(
  $$update public.dishes set household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
    where id = '0d000001-0000-0000-0000-000000000001'$$,
  '42501', null, 'move: H member cannot UPDATE an H dish into K (RLS WITH CHECK)'
);

select tests.clear_auth();

select * from finish();
rollback;
