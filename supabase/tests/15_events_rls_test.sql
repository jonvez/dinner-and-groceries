-- RLS + append-only: events (cross-cutting analytics plumbing; ADR 0004 #3,
-- SPEC "Analytics & Outcome Tracking"). household_id DENORMALIZED and scoped
-- through the SINGLE 1a chokepoint `public.current_household_id()` (ADR 0003),
-- exactly like the social tables. member_id is NULLABLE (pre-membership usage
-- events such as `sign_in`). The table is APPEND-ONLY for clients: only SELECT
-- and INSERT policies + privileges exist — no UPDATE/DELETE policy AND no
-- UPDATE/DELETE grant to `authenticated`, so clients can neither mutate nor
-- delete an emitted event (defense in depth: privilege check fails before RLS).
--
-- pgTAP test (issue #16). One rolled-back transaction; fixtures inlined.
begin;
select plan(11);

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

-- ---- seed one attributed event for each household ----
insert into public.events (id, household_id, member_id, event_type, payload) values
  ('ce000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000002-0000-0000-0000-000000000002', 'proposal_created', '{"proposal_id": "seed"}'),
  ('ce000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'b0000002-0000-0000-0000-000000000002', 'proposal_created', '{"proposal_id": "seed"}');

select is(
  (select relrowsecurity from pg_class where oid = 'public.events'::regclass),
  true, 'events has RLS enabled'
);
select is(
  (select relforcerowsecurity from pg_class where oid = 'public.events'::regclass),
  true, 'events has RLS FORCEd (owner not exempt)'
);

-- ---- allow-same: H member reads H's event ----
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');
select is(
  (select count(*)::int from public.events where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1, 'allow-same: H member can read H''s event'
);

-- ---- deny-cross: H member cannot read K's event ----
select is(
  (select count(*)::int from public.events where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  0, 'deny-cross: H member cannot read K''s event'
);

-- ---- allow-same: H member can emit (insert) an event in H (H now has 2) ----
insert into public.events (household_id, member_id, event_type, payload)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000002-0000-0000-0000-000000000002', 'reaction_added', '{}');
select is(
  (select count(*)::int from public.events where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  2, 'allow-same: H member can emit an event in H (H now has 2)'
);

-- ---- member_id may be null: a pre-membership usage event (e.g. sign_in) ----
insert into public.events (household_id, member_id, event_type, payload)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'session_start', '{}');
select is(
  (select count(*)::int from public.events where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' and member_id is null),
  1, 'member_id may be null: a null-member usage event is accepted'
);

-- ---- taxonomy enforced at the DB layer: an out-of-taxonomy event_type is
--      rejected by the enum (ADR 0004 dropped `app_open` as a synonym of
--      `session_start`). Guards against a feature slice emitting an ad hoc type
--      via a raw insert that bypasses the typed helper. ----
select throws_ok(
  $$insert into public.events (household_id, event_type)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'app_open')$$,
  '22P02', null, 'taxonomy: an out-of-taxonomy event_type is rejected by the enum'
);

-- ---- deny-cross: H member cannot emit an event tagged to K ----
select throws_ok(
  $$insert into public.events (household_id, event_type)
    values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'session_start')$$,
  '42501', null, 'deny-cross: H member cannot emit an event into K'
);

-- ---- append-only: UPDATE is denied to clients (no policy + no privilege) ----
select throws_ok(
  $$update public.events set payload = '{"tamper": true}'
    where id = 'ce000001-0000-0000-0000-000000000001'$$,
  '42501', null, 'append-only: client UPDATE of an event is denied'
);

-- ---- append-only: DELETE is denied to clients (no policy + no privilege) ----
select throws_ok(
  $$delete from public.events where id = 'ce000001-0000-0000-0000-000000000001'$$,
  '42501', null, 'append-only: client DELETE of an event is denied'
);

-- ---- append-only: TRUNCATE is denied to clients. TRUNCATE bypasses RLS and is
--      a bulk delete, so the append-only invariant needs the TRUNCATE privilege
--      revoked too — the project-wide default privilege (pg_default_acl) grants
--      it to authenticated/anon on every public table (#49); this migration
--      revokes it back for events. ----
select throws_ok(
  $$truncate public.events$$,
  '42501', null, 'append-only: client TRUNCATE of the events log is denied'
);
select tests.clear_auth();

select * from finish();
rollback;
