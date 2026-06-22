-- RLS: members — allow-same, deny-cross, owner-only remove (role enforcement).
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

-- Let the (post-authenticate_as) `authenticated` role reach the test helpers.
grant usage on schema tests to authenticated;
grant execute on all functions in schema tests to authenticated;

select is(
  (select relrowsecurity from pg_class where oid = 'public.members'::regclass),
  true, 'members has RLS enabled'
);

-- ---- allow-same: H member sees both H members ----
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');
select is(
  (select count(*)::int from public.members where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  2, 'allow-same: H member can read all of H''s members'
);

-- ---- deny-cross: H member sees none of K's members ----
select is(
  (select count(*)::int from public.members where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  0, 'deny-cross: H member cannot read K''s members'
);

-- ---- role: non-owner (H member) cannot remove a member ----
delete from public.members where id = 'a0000001-0000-0000-0000-000000000001';
select tests.clear_auth();
select is(
  (select count(*)::int from public.members where id = 'a0000001-0000-0000-0000-000000000001'),
  1, 'role: a non-owner member cannot delete a member (row survives)'
);

-- ---- role: owner CAN remove a member of their household ----
select tests.authenticate_as('11111111-1111-1111-1111-111111111111');
delete from public.members where id = 'a0000002-0000-0000-0000-000000000002';
select tests.clear_auth();
select is(
  (select count(*)::int from public.members where id = 'a0000002-0000-0000-0000-000000000002'),
  0, 'role: an owner can delete a member of their own household'
);

-- ---- deny-cross: K owner cannot remove an H member ----
select tests.authenticate_as('33333333-3333-3333-3333-333333333333');
delete from public.members where id = 'a0000001-0000-0000-0000-000000000001';
select tests.clear_auth();
select is(
  (select count(*)::int from public.members where id = 'a0000001-0000-0000-0000-000000000001'),
  1, 'deny-cross: K owner cannot delete an H member'
);

-- ---- allow-same: owner can update a member row in their household ----
select tests.authenticate_as('11111111-1111-1111-1111-111111111111');
update public.members set display_name = 'H Owner!' where id = 'a0000001-0000-0000-0000-000000000001';
select is(
  (select display_name from public.members where id = 'a0000001-0000-0000-0000-000000000001'),
  'H Owner!', 'allow-same: owner can update a member row in their household'
);

-- ---- deny-cross: H owner cannot update a K member ----
update public.members set display_name = 'pwned' where id = 'b0000002-0000-0000-0000-000000000002';
select tests.clear_auth();
select is(
  (select display_name from public.members where id = 'b0000002-0000-0000-0000-000000000002'),
  'K Member', 'deny-cross: H owner cannot update a K member (row unchanged)'
);

-- ---- role: a non-owner member CANNOT self-promote to owner ----
-- (privilege escalation guard — UPDATE on members.role is not granted to the
-- authenticated role, so writing role is denied even on one's own row.)
select tests.authenticate_as('44444444-4444-4444-4444-444444444444');
select throws_ok(
  $$update public.members set role = 'owner' where user_id = '44444444-4444-4444-4444-444444444444'$$,
  '42501', null, 'role: a non-owner member cannot self-promote to owner'
);
select tests.clear_auth();
select is(
  (select role::text from public.members where user_id = '44444444-4444-4444-4444-444444444444'),
  'member', 'role: the would-be self-promoter is still a member'
);

select * from finish();
rollback;
