-- Household-creation bootstrap + invite-accept (issue #6).
--
-- #4 deliberately left NO INSERT policy on households/members: a brand-new user
-- has no household to self-reference, so a self-referential INSERT policy is
-- impossible. Creation therefore goes through SECURITY DEFINER bootstraps that
-- atomically create the household + the owner member row (create_household) and
-- create a member row after consuming an invite (accept_invite). These tests
-- pin the security-critical contract those functions must satisfy:
--   * SECURITY DEFINER, search_path = '', execute granted to `authenticated`
--     only (revoked from public/anon).
--   * create_household: makes households + owner member atomically, rejects a
--     user who already belongs to a household, requires auth.
--   * accept_invite: reuses consume_invite single-use/expiry, creates a `member`
--     row, rejects already-consumed/expired/invalid tokens, requires auth, and
--     rejects a user who already belongs to a household.
begin;
select plan(25);

create schema if not exists tests;

insert into auth.users (id, instance_id, aud, role, email) values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'owner@test.local'),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'joiner@test.local'),
  ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'second-joiner@test.local'),
  ('44444444-4444-4444-4444-444444444444', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'already-member@test.local');

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

-- ===========================================================================
-- Security contract: definer-rights + locked-down grants.
-- ===========================================================================
select has_function('public', 'create_household', array['text', 'text'],
  'public.create_household(text, text) exists');
select has_function('public', 'accept_invite', array['text', 'text'],
  'public.accept_invite(text, text) exists');

select is(
  (select prosecdef from pg_proc where proname = 'create_household' and pronamespace = 'public'::regnamespace),
  true, 'create_household() is SECURITY DEFINER');
select is(
  (select prosecdef from pg_proc where proname = 'accept_invite' and pronamespace = 'public'::regnamespace),
  true, 'accept_invite() is SECURITY DEFINER');

-- search_path pinned empty (no hijack of the definer-rights function).
-- Postgres stores `set search_path = ''` as the proconfig entry `search_path=""`.
select is(
  (select proconfig from pg_proc where proname = 'create_household' and pronamespace = 'public'::regnamespace),
  array['search_path=""'], 'create_household() pins search_path = ''''');
select is(
  (select proconfig from pg_proc where proname = 'accept_invite' and pronamespace = 'public'::regnamespace),
  array['search_path=""'], 'accept_invite() pins search_path = ''''');

-- anon must NOT be able to execute either bootstrap.
select is(
  has_function_privilege('anon', 'public.create_household(text, text)', 'execute'),
  false, 'anon cannot execute create_household()');
select is(
  has_function_privilege('anon', 'public.accept_invite(text, text)', 'execute'),
  false, 'anon cannot execute accept_invite()');
select is(
  has_function_privilege('authenticated', 'public.create_household(text, text)', 'execute'),
  true, 'authenticated CAN execute create_household()');
select is(
  has_function_privilege('authenticated', 'public.accept_invite(text, text)', 'execute'),
  true, 'authenticated CAN execute accept_invite()');

-- ===========================================================================
-- create_household: happy path.
-- ===========================================================================
select tests.authenticate_as('11111111-1111-1111-1111-111111111111');
select lives_ok(
  $$select public.create_household('The Owners', 'Owner One')$$,
  'create_household: a member-less user can create a household');
select tests.clear_auth();

-- household row exists with the caller as owner_id.
select is(
  (select count(*)::int from public.households where owner_id = '11111111-1111-1111-1111-111111111111'
    and name = 'The Owners'),
  1, 'create_household: creates a households row owned by the caller');

-- an `owner` member row exists for the caller in that household.
select is(
  (select count(*)::int
   from public.members m
   join public.households h on h.id = m.household_id
   where m.user_id = '11111111-1111-1111-1111-111111111111'
     and m.role = 'owner'
     and m.display_name = 'Owner One'
     and h.owner_id = '11111111-1111-1111-1111-111111111111'),
  1, 'create_household: creates an OWNER member row for the caller');

-- ===========================================================================
-- create_household: a user who already belongs to a household is rejected.
-- ===========================================================================
select tests.authenticate_as('11111111-1111-1111-1111-111111111111');
select throws_ok(
  $$select public.create_household('Second House', 'Owner Again')$$,
  null, null, 'create_household: rejects a user who already has a membership');
select tests.clear_auth();

-- ===========================================================================
-- create_household: anonymous (no auth.uid()) is rejected.
-- ===========================================================================
select throws_ok(
  $$select public.create_household('Anon House', 'Nobody')$$,
  null, null, 'create_household: rejects an unauthenticated caller');

-- ===========================================================================
-- accept_invite: happy path joins the inviting household as a `member`.
-- ===========================================================================
-- The owner mints an invite (owner-gated RLS insert from #4).
select tests.authenticate_as('11111111-1111-1111-1111-111111111111');
insert into public.invites (household_id, token, created_by)
select id, 'good-token', '11111111-1111-1111-1111-111111111111'
from public.households where owner_id = '11111111-1111-1111-1111-111111111111';
select tests.clear_auth();

-- Capture the expected household id in a privileged (RLS-exempt) context into a
-- session GUC, so the assertion does not depend on RLS visibility ordering.
select tests.clear_auth();
select set_config('tests.expected_household',
  (select household_id::text from public.invites where token = 'good-token'), false);

select tests.authenticate_as('22222222-2222-2222-2222-222222222222');
select is(
  (select public.accept_invite('good-token', 'Joiner Two')),
  current_setting('tests.expected_household')::uuid,
  'accept_invite: returns the household_id of the joined household');
select tests.clear_auth();

-- a `member` (not owner) row now exists for the joiner in that household.
select is(
  (select count(*)::int
   from public.members
   where user_id = '22222222-2222-2222-2222-222222222222'
     and role = 'member'
     and display_name = 'Joiner Two'),
  1, 'accept_invite: creates a MEMBER (non-owner) row for the joiner');

-- the invite is now consumed (single-use stamped).
select is(
  (select consumed_by from public.invites where token = 'good-token'),
  '22222222-2222-2222-2222-222222222222'::uuid,
  'accept_invite: stamps consumed_by on the invite');
select isnt(
  (select consumed_at from public.invites where token = 'good-token'),
  null, 'accept_invite: stamps consumed_at on the invite');

-- ===========================================================================
-- accept_invite: single-use — a second user cannot reuse the consumed token,
-- and NO member row is created for them (atomic: consume + insert together).
-- ===========================================================================
select tests.authenticate_as('33333333-3333-3333-3333-333333333333');
select throws_ok(
  $$select public.accept_invite('good-token', 'Too Late')$$,
  null, null, 'accept_invite: rejects an already-consumed token (single-use)');
select tests.clear_auth();
select is(
  (select count(*)::int from public.members where user_id = '33333333-3333-3333-3333-333333333333'),
  0, 'accept_invite: no member row is created when the token is already consumed');

-- ===========================================================================
-- accept_invite: expired token is rejected, no member created.
-- ===========================================================================
select tests.authenticate_as('11111111-1111-1111-1111-111111111111');
insert into public.invites (household_id, token, created_by, expires_at)
select id, 'expired-token', '11111111-1111-1111-1111-111111111111', now() - interval '1 minute'
from public.households where owner_id = '11111111-1111-1111-1111-111111111111';
select tests.clear_auth();

select tests.authenticate_as('33333333-3333-3333-3333-333333333333');
select throws_ok(
  $$select public.accept_invite('expired-token', 'Too Late')$$,
  null, null, 'accept_invite: rejects an expired token');
select tests.clear_auth();

-- ===========================================================================
-- accept_invite: invalid token rejected.
-- ===========================================================================
select tests.authenticate_as('33333333-3333-3333-3333-333333333333');
select throws_ok(
  $$select public.accept_invite('no-such-token', 'Ghost')$$,
  null, null, 'accept_invite: rejects an unknown token');
select tests.clear_auth();

-- ===========================================================================
-- accept_invite: a user who already belongs to a household cannot join another
-- (MVP single-household invariant — fail BEFORE consuming a fresh invite).
-- ===========================================================================
-- give user 44 their own household first.
select tests.authenticate_as('44444444-4444-4444-4444-444444444444');
select public.create_household('Existing House', 'Already Member');
select tests.clear_auth();

-- owner mints a fresh, valid invite into the Owners household.
select tests.authenticate_as('11111111-1111-1111-1111-111111111111');
insert into public.invites (household_id, token, created_by)
select id, 'fresh-token', '11111111-1111-1111-1111-111111111111'
from public.households where owner_id = '11111111-1111-1111-1111-111111111111';
select tests.clear_auth();

select tests.authenticate_as('44444444-4444-4444-4444-444444444444');
select throws_ok(
  $$select public.accept_invite('fresh-token', 'Double Dip')$$,
  null, null, 'accept_invite: rejects a user who already belongs to a household');
select tests.clear_auth();

-- and that fresh invite must remain UNCONSUMED (the guard fired before consume).
select is(
  (select consumed_at from public.invites where token = 'fresh-token'),
  null, 'accept_invite: a rejected (already-member) join does not consume the invite');

select * from finish();
rollback;
