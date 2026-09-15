-- RLS + append-only: events (cross-cutting analytics plumbing; ADR 0004 #3,
-- SPEC "Analytics & Outcome Tracking"). household_id DENORMALIZED and scoped
-- through the SINGLE 1a chokepoint `public.current_household_id()` (ADR 0003),
-- exactly like the social tables. member_id is NULLABLE (pre-membership usage
-- events such as `sign_in`). The table is APPEND-ONLY for clients: only SELECT
-- and INSERT policies + privileges exist — no UPDATE/DELETE policy AND no
-- UPDATE/DELETE grant to `authenticated`, so clients can neither mutate nor
-- delete an emitted event (defense in depth: privilege check fails before RLS).
--
-- ASYMMETRIC by design since issue #17 (ADR 0014): SELECT is OWNER-only,
-- INSERT stays household-scoped. Every member emits events; only the household
-- owner may read them. The PO dashboard exists for the parent alone (north
-- star: never a kid-facing scorecard), so the boundary is RLS — not the
-- `/dashboard` route check, which is only the route's behaviour. Without the
-- owner term in `events_select`, any member (the teens included) could read
-- every event row straight through the Data API and the route check would be a
-- curtain over an open door. The deny case below is what proves that shut.
--
-- pgTAP test (issues #16, #17). One rolled-back transaction; fixtures inlined.
begin;
select plan(19);

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

-- ---- allow-owner: the H OWNER reads H's event (the PO dashboard's read) ----
select tests.authenticate_as('11111111-1111-1111-1111-111111111111');
select is(
  (select count(*)::int from public.events where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  1, 'allow-owner: the H owner can read H''s event'
);

-- ---- DENY-NON-OWNER (issue #17, the owner gate): a same-household member who
--      is NOT the owner reads ZERO event rows, even in their OWN household.
--      This is the assertion that makes `/dashboard`'s 404 more than cosmetic:
--      it holds for a raw Data API query that never touches the route. ----
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');
select is(
  (select count(*)::int from public.events where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  0, 'deny-non-owner: a same-household NON-owner member reads no event rows'
);

-- ---- deny-cross: H member cannot read K's event ----
select is(
  (select count(*)::int from public.events where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  0, 'deny-cross: H member cannot read K''s event'
);

-- ---- allow-same INSERT: a NON-owner member still emits events. Every member
--      emits, only the owner reads — so the insert is asserted with lives_ok
--      (the emitter can no longer read back what it wrote), and the row is
--      counted below as the owner. ----
select lives_ok(
  $$insert into public.events (household_id, member_id, event_type, payload)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000002-0000-0000-0000-000000000002', 'reaction_added', '{}')$$,
  'allow-same: a NON-owner member can still emit an event in H'
);

-- ---- THE READ-BACK TRAP (issue #17; security review of PR #223, F2). Making
--      SELECT owner-only silently narrows the WRITE path too for anyone who
--      reads back what they wrote: PostgreSQL requires the SELECT policy to
--      pass for a RETURNING row, so a NON-owner's `insert ... returning` is
--      rejected outright while the identical statement succeeds for the owner.
--
--      Nothing is broken today — `emitEvent` issues a bare `.insert()` with no
--      `.select()` (supabase-js sends `Prefer: return=minimal`, so no
--      RETURNING clause is generated). This pins the trap so it cannot be
--      walked into: adding a read-back to the emit path is a very natural
--      change (e.g. to correlate an event id), and it would break emission for
--      BOTH teens while continuing to work perfectly for the owner — the one
--      person most likely to be testing it. `emitEvent` swallows the error, so
--      the first symptom would be a dashboard quietly under-reporting the kids,
--      which is the exact number this whole feature exists to get right.
--
--      If this assertion ever fails, do NOT relax it by loosening
--      `events_select` — keep the insert write-only (see the warning comment in
--      `lib/analytics/events.ts`). ----
select throws_ok(
  $$insert into public.events (household_id, member_id, event_type, payload)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'a0000002-0000-0000-0000-000000000002', 'reaction_added', '{}')
    returning id$$,
  '42501', null,
  'deny-readback: a NON-owner''s INSERT ... RETURNING is denied (RETURNING needs the SELECT policy)'
);

-- ---- member_id may be null: a pre-membership usage event (e.g. sign_in) ----
select lives_ok(
  $$insert into public.events (household_id, member_id, event_type, payload)
    values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null, 'session_start', '{}')$$,
  'member_id may be null: a null-member usage event is accepted'
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

-- ---- the OWNER's new read access is SELECT-only: append-only is unchanged for
--      them too (issue #17). Reading every event does not imply editing one —
--      there is no UPDATE/DELETE policy AND no UPDATE/DELETE grant, and FORCE
--      RLS keeps even a table owner non-exempt. ----
select tests.authenticate_as('11111111-1111-1111-1111-111111111111');
select is(
  (select count(*)::int from public.events where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  3, 'allow-owner: the owner reads the member-emitted rows too (H now has 3)'
);
select throws_ok(
  $$update public.events set payload = '{"tamper": true}'
    where id = 'ce000001-0000-0000-0000-000000000001'$$,
  '42501', null, 'append-only: the OWNER cannot UPDATE an event either'
);
select throws_ok(
  $$delete from public.events where id = 'ce000001-0000-0000-0000-000000000001'$$,
  '42501', null, 'append-only: the OWNER cannot DELETE an event either'
);
select throws_ok(
  $$truncate public.events$$,
  '42501', null, 'append-only: the OWNER cannot TRUNCATE the events log either'
);

-- ---- deny-cross for the owner gate: being an owner grants no reach into
--      ANOTHER household's events (K's owner sees only K's row). ----
select tests.authenticate_as('33333333-3333-3333-3333-333333333333');
select is(
  (select count(*)::int from public.events where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  0, 'deny-cross: K''s OWNER cannot read H''s events'
);
select is(
  (select count(*)::int from public.events where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  1, 'allow-owner: K''s owner reads K''s own event'
);
select tests.clear_auth();

select * from finish();
rollback;
