-- Invite integrity: single-use (consumed) + expiry rejected at the data layer.
--
-- Joining happens BEFORE a member row exists, so consumption goes through a
-- SECURITY DEFINER function `public.consume_invite(token)` that validates the
-- invite (not expired, not already consumed), stamps consumed_at/consumed_by,
-- and returns the household_id. The function is the sole sanctioned consume
-- path and is what the data layer rejects against.
begin;
select plan(7);

create schema if not exists tests;

insert into auth.users (id, instance_id, aud, role, email) values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'h-owner@test.local'),
  ('99999999-9999-9999-9999-999999999999', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nobody@test.local');

insert into public.households (id, name, owner_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Household H', '11111111-1111-1111-1111-111111111111');

insert into public.members (id, household_id, user_id, display_name, role) values
  ('a0000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'H Owner', 'owner');

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

-- Let the (post-authenticate_as) `authenticated` role reach the test helpers.
grant usage on schema tests to authenticated;
grant execute on all functions in schema tests to authenticated;

select has_function('public', 'consume_invite', 'public.consume_invite(text) exists');
select is(
  (select prosecdef from pg_proc where proname = 'consume_invite' and pronamespace = 'public'::regnamespace),
  true, 'consume_invite() is SECURITY DEFINER'
);

-- Seed a valid invite and an expired invite (privileged bootstrap path).
insert into public.invites (id, household_id, token, created_by, expires_at) values
  ('d0000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'valid-token',   '11111111-1111-1111-1111-111111111111', now() + interval '7 days'),
  ('d0000002-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'expired-token', '11111111-1111-1111-1111-111111111111', now() - interval '1 minute');

-- A valid, unexpired token consumes successfully and returns the household.
select tests.authenticate_as('99999999-9999-9999-9999-999999999999');
select is(
  (select public.consume_invite('valid-token')),
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
  'consume: a valid token returns its household_id'
);

-- ...and stamps consumed_at / consumed_by.
select tests.clear_auth();
select isnt(
  (select consumed_at from public.invites where token = 'valid-token'),
  null, 'consume: consumed_at is stamped on use'
);
select is(
  (select consumed_by from public.invites where token = 'valid-token'),
  '99999999-9999-9999-9999-999999999999'::uuid,
  'consume: consumed_by is stamped with the consuming user'
);

-- Single-use: re-consuming the same (now consumed) token is rejected.
select tests.authenticate_as('99999999-9999-9999-9999-999999999999');
select throws_ok(
  $$select public.consume_invite('valid-token')$$,
  null, null, 'single-use: an already-consumed token is rejected'
);

-- Expiry: an expired token is rejected.
select throws_ok(
  $$select public.consume_invite('expired-token')$$,
  null, null, 'expiry: an expired token is rejected'
);
select tests.clear_auth();

select * from finish();
rollback;
