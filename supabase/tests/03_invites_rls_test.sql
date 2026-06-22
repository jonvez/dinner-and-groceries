-- RLS: invites — allow-same/deny-cross + owner-only insert/delete.
begin;
select plan(7);

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
  ('b0000001-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '33333333-3333-3333-3333-333333333333', 'K Owner', 'owner');

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

select is(
  (select relrowsecurity from pg_class where oid = 'public.invites'::regclass),
  true, 'invites has RLS enabled'
);

-- ---- role: owner CAN create an invite for their household ----
select tests.authenticate_as('11111111-1111-1111-1111-111111111111');
insert into public.invites (id, household_id, token, created_by)
values ('c0000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'h-token-1', '11111111-1111-1111-1111-111111111111');
select tests.clear_auth();
select is(
  (select count(*)::int from public.invites where token = 'h-token-1'),
  1, 'role: owner can insert an invite for their own household'
);

-- ---- role: non-owner member CANNOT create an invite ----
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');
select throws_ok(
  $$insert into public.invites (household_id, token, created_by)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'h-token-2', '22222222-2222-2222-2222-222222222222')$$,
  '42501', null, 'role: a non-owner member cannot insert an invite (RLS violation)'
);

-- ---- allow-same: H member can read their household's invites ----
select is(
  (select count(*)::int from public.invites where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1, 'allow-same: H member can read H''s invites'
);

-- ---- deny-cross: K owner cannot read H's invites ----
select tests.authenticate_as('33333333-3333-3333-3333-333333333333');
select is(
  (select count(*)::int from public.invites where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  0, 'deny-cross: K owner cannot read H''s invites'
);

-- ---- deny-cross: K owner cannot insert an invite into H ----
select throws_ok(
  $$insert into public.invites (household_id, token, created_by)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'cross-token', '33333333-3333-3333-3333-333333333333')$$,
  '42501', null, 'deny-cross: K owner cannot insert an invite into household H'
);

-- ---- role: only owner can delete an invite ----
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');
delete from public.invites where token = 'h-token-1';
select tests.clear_auth();
select is(
  (select count(*)::int from public.invites where token = 'h-token-1'),
  1, 'role: a non-owner member cannot delete an invite'
);

select * from finish();
rollback;
