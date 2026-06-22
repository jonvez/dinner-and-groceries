-- RLS: households — allow-same-household, deny-cross-household, + helper shape.
--
-- pgTAP test. Runs in one transaction that is rolled back at the end, so the
-- seeds below never persist. Fixtures are inlined (not \i-included) so each
-- test file is fully self-contained and isolated.
begin;
select plan(8);

-- ---- fixtures: two households (H, K), each owner + member; one outsider ----
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

-- Let the (post-authenticate_as) `authenticated` role reach the test helpers.
grant usage on schema tests to authenticated;
grant execute on all functions in schema tests to authenticated;

-- ---- the SECURITY DEFINER helper must exist + be SECURITY DEFINER (ADR 0003) ----
select has_function('public', 'current_household_id', 'public.current_household_id() helper exists');
select is(
  (select prosecdef from pg_proc where proname = 'current_household_id' and pronamespace = 'public'::regnamespace),
  true,
  'current_household_id() is SECURITY DEFINER (breaks RLS recursion)'
);

-- ---- RLS enabled AND forced on households ----
-- FORCE matters: without it the table owner bypasses RLS. Assert both so a
-- future migration that drops FORCE fails loudly instead of silently.
select is(
  (select relrowsecurity from pg_class where oid = 'public.households'::regclass),
  true,
  'households has RLS enabled'
);
select is(
  (select relforcerowsecurity from pg_class where oid = 'public.households'::regclass),
  true,
  'households has RLS FORCEd (owner not exempt)'
);

-- ---- allow-same: H owner reads their own household ----
select tests.authenticate_as('11111111-1111-1111-1111-111111111111');
select is(
  (select count(*)::int from public.households where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1, 'allow-same: H owner can read their own household'
);

-- ---- deny-cross: H owner cannot read K ----
select is(
  (select count(*)::int from public.households where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  0, 'deny-cross: H owner cannot read household K'
);

-- ---- allow-same: H member can update their household name ----
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');
update public.households set name = 'H renamed' where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
select is(
  (select name from public.households where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'H renamed', 'allow-same: H member can update their own household'
);

-- ---- deny-cross: H member cannot update K's household ----
update public.households set name = 'K hijacked' where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
select tests.clear_auth();
select is(
  (select name from public.households where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  'Household K', 'deny-cross: H member cannot update household K (row unchanged)'
);

select * from finish();
rollback;
