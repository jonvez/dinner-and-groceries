-- RLS + integrity: dish_phases / dish_steps (issue #272, recipe steps as data).
-- Both are dish children with household_id denormalized (ADR 0003), so they
-- mirror 17_ingredients_rls_test.sql: allow-same / deny-cross, the composite
-- FKs (including the phase-belongs-to-the-same-dish hardening), cascade on dish
-- delete, the non-blank body check, the size caps, and the deferred step-position uniqueness
-- that lets save_recipe reorder steps inside one transaction. Also pins the two
-- expand-only columns (ingredients.section, dishes.servings).
--
-- One rolled-back transaction; fixtures inlined so the file is self-contained.
begin;
select plan(32);

create schema if not exists tests;

insert into auth.users (id, instance_id, aud, role, email) values
  ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'h-owner@test.local'),
  ('22222222-2222-2222-2222-222222222222', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'h-member@test.local'),
  ('33333333-3333-3333-3333-333333333333', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'k-owner@test.local');

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

grant usage on schema tests to authenticated;
grant execute on all functions in schema tests to authenticated;

-- ---- seed (privileged role: bypasses RLS) ----
insert into public.dishes (id, household_id, title, created_by) values
  ('0d000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'H Soup',      'a0000001-0000-0000-0000-000000000001'),
  ('0d000003-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'H Rigatoni',  'a0000001-0000-0000-0000-000000000001'),
  ('0d000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'K Tacos',     'b0000001-0000-0000-0000-000000000001');

insert into public.dish_phases (id, household_id, dish_id, position, title, intro) values
  ('0f000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0d000001-0000-0000-0000-000000000001', 0, 'Start', '{}'),
  ('0f000003-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0d000003-0000-0000-0000-000000000003', 0, '',      '{}'),
  ('0f000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '0d000002-0000-0000-0000-000000000002', 0, 'Prep',  '{}');

insert into public.dish_steps (id, household_id, dish_id, phase_id, position, body, notes) values
  ('05000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0d000001-0000-0000-0000-000000000001', '0f000001-0000-0000-0000-000000000001', 0, 'Cube the pork.', '{}'),
  ('05000003-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0d000001-0000-0000-0000-000000000001', '0f000001-0000-0000-0000-000000000001', 1, 'Into the pot.', '{"No salt yet."}'),
  ('05000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '0d000002-0000-0000-0000-000000000002', '0f000002-0000-0000-0000-000000000002', 0, 'Warm the tortillas.', '{}');

-- 1-4: RLS enabled + FORCED on both tables
select is((select relrowsecurity      from pg_class where oid = 'public.dish_phases'::regclass), true, 'dish_phases has RLS enabled');
select is((select relforcerowsecurity from pg_class where oid = 'public.dish_phases'::regclass), true, 'dish_phases has RLS FORCEd');
select is((select relrowsecurity      from pg_class where oid = 'public.dish_steps'::regclass),  true, 'dish_steps has RLS enabled');
select is((select relforcerowsecurity from pg_class where oid = 'public.dish_steps'::regclass),  true, 'dish_steps has RLS FORCEd');

-- 5-6: the expand-only columns
select has_column('public', 'ingredients', 'section', 'ingredients.section exists (ingredient groups)');
select has_column('public', 'dishes', 'servings', 'dishes.servings exists');

-- 7-10: allow-same / deny-cross reads
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');
select is((select count(*)::int from public.dish_phases where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 2, 'allow-same: H member reads H''s phases');
select is((select count(*)::int from public.dish_phases where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 0, 'deny-cross: H member cannot read K''s phases');
select is((select count(*)::int from public.dish_steps  where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 2, 'allow-same: H member reads H''s steps');
select is((select count(*)::int from public.dish_steps  where household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'), 0, 'deny-cross: H member cannot read K''s steps');

-- 11: allow-same insert of a step
insert into public.dish_steps (household_id, dish_id, phase_id, position, body)
  values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0d000001-0000-0000-0000-000000000001', '0f000001-0000-0000-0000-000000000001', 2, 'Simmer.');
select is((select count(*)::int from public.dish_steps where dish_id = '0d000001-0000-0000-0000-000000000001'), 3, 'allow-same: H member inserts a step into H''s dish');

-- 12-13: deny-cross inserts blocked by the insert policies
select throws_ok(
  $$insert into public.dish_phases (household_id, dish_id, position, title) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '0d000002-0000-0000-0000-000000000002', 1, 'pwned')$$,
  '42501', null, 'deny-cross: H member cannot insert a phase into K');
select throws_ok(
  $$insert into public.dish_steps (household_id, dish_id, phase_id, position, body) values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '0d000002-0000-0000-0000-000000000002', '0f000002-0000-0000-0000-000000000002', 1, 'pwned')$$,
  '42501', null, 'deny-cross: H member cannot insert a step into K');

-- 14-15: deny-cross update / delete are RLS no-ops; verify K's step untouched
update public.dish_steps set body = 'pwned' where id = '05000002-0000-0000-0000-000000000002';
delete from public.dish_phases where id = '0f000002-0000-0000-0000-000000000002';
select tests.clear_auth();
select is((select body from public.dish_steps where id = '05000002-0000-0000-0000-000000000002'), 'Warm the tortillas.', 'deny-cross: H member cannot update K''s step (unchanged)');
select is((select count(*)::int from public.dish_phases where id = '0f000002-0000-0000-0000-000000000002'), 1, 'deny-cross: H member cannot delete K''s phase (still there)');

-- 16: allow-same update moves a row only within the household (WITH CHECK)
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');
select throws_ok(
  $$update public.dish_steps set household_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' where id = '05000001-0000-0000-0000-000000000001'$$,
  '42501', null, 'deny-cross: H member cannot move H''s step into K');
select tests.clear_auth();

-- 17-19: composite-FK integrity (as the privileged role, so only the FKs can say no)
select throws_ok(
  $$insert into public.dish_phases (household_id, dish_id, position) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0d000002-0000-0000-0000-000000000002', 5)$$,
  '23503', null, 'integrity: phase (dish_id, household_id) must match a dish');
select throws_ok(
  $$insert into public.dish_steps (household_id, dish_id, phase_id, position, body) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0d000002-0000-0000-0000-000000000002', '0f000002-0000-0000-0000-000000000002', 5, 'x')$$,
  '23503', null, 'integrity: step (dish_id, household_id) must match a dish');
select throws_ok(
  $$insert into public.dish_steps (household_id, dish_id, phase_id, position, body) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0d000003-0000-0000-0000-000000000003', '0f000001-0000-0000-0000-000000000001', 5, 'x')$$,
  '23503', null, 'integrity: a step''s phase must belong to the SAME dish (phase_id, dish_id) FK');

-- 20: a step body must be non-blank
select throws_ok(
  $$insert into public.dish_steps (household_id, dish_id, phase_id, position, body) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0d000001-0000-0000-0000-000000000001', '0f000001-0000-0000-0000-000000000001', 9, '   ')$$,
  '23514', null, 'integrity: a step body cannot be blank');

-- 21: step positions are unique per dish (checked at commit; forced here)
select throws_ok(
  $$insert into public.dish_steps (household_id, dish_id, phase_id, position, body) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0d000001-0000-0000-0000-000000000001', '0f000001-0000-0000-0000-000000000001', 0, 'dup'); set constraints all immediate$$,
  '23505', null, 'integrity: two steps of one dish cannot share a position');
set constraints all deferred;

-- 22: ...but a swap inside one transaction is fine (the constraint is deferred)
select lives_ok(
  $$update public.dish_steps set position = 1 where id = '05000001-0000-0000-0000-000000000001';
    update public.dish_steps set position = 0 where id = '05000003-0000-0000-0000-000000000003';
    set constraints all immediate$$,
  'integrity: swapping two step positions inside one transaction is allowed (deferred unique)');
set constraints all deferred;

-- 23: phase positions are unique per dish
select throws_ok(
  $$insert into public.dish_phases (household_id, dish_id, position) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0d000001-0000-0000-0000-000000000001', 0); set constraints all immediate$$,
  '23505', null, 'integrity: two phases of one dish cannot share a position');
set constraints all deferred;

-- 24: deleting a phase removes its steps
delete from public.dish_phases where id = '0f000001-0000-0000-0000-000000000001';
select is((select count(*)::int from public.dish_steps where phase_id = '0f000001-0000-0000-0000-000000000001'), 0, 'cascade: deleting a phase removes its steps');

-- 25-26: deleting a dish removes its phases and steps
delete from public.dishes where id = '0d000002-0000-0000-0000-000000000002';
select is((select count(*)::int from public.dish_phases where dish_id = '0d000002-0000-0000-0000-000000000002'), 0, 'cascade: deleting a dish removes its phases');
select is((select count(*)::int from public.dish_steps  where dish_id = '0d000002-0000-0000-0000-000000000002'), 0, 'cascade: deleting a dish removes its steps');

-- 27-32: size caps (security review M1). Any member can write these columns
-- directly, and step text is rendered on every view, so the table bounds it,
-- not just save_recipe.
select throws_ok(
  $$insert into public.dish_steps (household_id, dish_id, phase_id, position, body) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0d000003-0000-0000-0000-000000000003', '0f000003-0000-0000-0000-000000000003', 10, repeat('x', 4001))$$,
  '23514', null, 'size cap: a step body over 4000 characters is rejected');
select lives_ok(
  $$insert into public.dish_steps (household_id, dish_id, phase_id, position, body) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0d000003-0000-0000-0000-000000000003', '0f000003-0000-0000-0000-000000000003', 11, repeat('x', 4000))$$,
  'size cap: a step body of exactly 4000 characters is allowed');
select throws_ok(
  $$insert into public.dish_steps (household_id, dish_id, phase_id, position, body, notes) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0d000003-0000-0000-0000-000000000003', '0f000003-0000-0000-0000-000000000003', 12, 'Stir.', array(select 'n' from generate_series(1, 51)))$$,
  '23514', null, 'size cap: more than 50 notes on a step is rejected');
select throws_ok(
  $$insert into public.dish_phases (household_id, dish_id, position, intro) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0d000003-0000-0000-0000-000000000003', 10, array(select 'i' from generate_series(1, 51)))$$,
  '23514', null, 'size cap: more than 50 intro lines on a phase is rejected');
select throws_ok(
  $$insert into public.dish_phases (household_id, dish_id, position, title) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '0d000003-0000-0000-0000-000000000003', 11, repeat('t', 201))$$,
  '23514', null, 'size cap: a phase title over 200 characters is rejected');
select throws_ok(
  $$update public.dishes set servings = repeat('s', 101) where id = '0d000003-0000-0000-0000-000000000003'$$,
  '23514', null, 'size cap: servings over 100 characters is rejected');

select * from finish();
rollback;
