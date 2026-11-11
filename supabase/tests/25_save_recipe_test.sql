-- save_recipe(p_recipe jsonb) — the one atomic recipe write path (issue #272).
--
-- SECURITY INVOKER, so RLS does every bit of household scoping; this file pins
-- the function's posture (invoker, pinned search_path, authenticated-only) and
-- its semantics: create, update-by-id, the never-create-on-a-bad-id
-- idempotency rule (P0002), stable step ids (kept id preserved, stale step
-- deleted), tags left alone when omitted, and `description` never written.
--
-- One rolled-back transaction; fixtures inlined so the file is self-contained.
begin;
select plan(38);

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

-- Scratch space for ids produced mid-test (the tests schema is rolled back).
create table tests.saved (key text primary key, id uuid);
grant usage on schema tests to authenticated;
grant execute on all functions in schema tests to authenticated;
grant select, insert, update on tests.saved to authenticated;

-- K's dish + step, seeded privileged, to aim cross-household writes at.
insert into public.dishes (id, household_id, title, tags, description, created_by) values
  ('0d000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'K Tacos', '{taco}', 'K legacy', 'b0000001-0000-0000-0000-000000000001');
insert into public.dish_phases (id, household_id, dish_id, position, title) values
  ('0f000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '0d000002-0000-0000-0000-000000000002', 0, 'Prep');
insert into public.dish_steps (id, household_id, dish_id, phase_id, position, body) values
  ('05000002-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '0d000002-0000-0000-0000-000000000002', '0f000002-0000-0000-0000-000000000002', 0, 'Warm the tortillas.');

-- ---------------------------------------------------------------------------
-- Posture
-- ---------------------------------------------------------------------------
-- 1-5
select has_function('public', 'save_recipe', array['jsonb'], 'save_recipe(jsonb) exists');
select is((select prosecdef from pg_proc where oid = 'public.save_recipe(jsonb)'::regprocedure), false, 'save_recipe is SECURITY INVOKER (RLS does the scoping)');
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid = 'public.save_recipe(jsonb)'::regprocedure), 'save_recipe pins search_path to empty');
select ok(not has_function_privilege('anon', 'public.save_recipe(jsonb)', 'execute'), 'anon cannot execute save_recipe');
select ok(has_function_privilege('authenticated', 'public.save_recipe(jsonb)', 'execute'), 'authenticated can execute save_recipe');

-- 6: an authenticated-role caller with no user (no JWT sub) is refused
select tests.clear_auth();
set local role authenticated;
select throws_ok(
  $$select public.save_recipe('{"title":"Nobody''s"}'::jsonb)$$,
  '28000', null, 'unauthenticated: no member, no household -> 28000');
reset role;

-- ---------------------------------------------------------------------------
-- Create
-- ---------------------------------------------------------------------------
select tests.authenticate_as('22222222-2222-2222-2222-222222222222');

insert into tests.saved (key, id) values ('dish', public.save_recipe($json${
  "id": null,
  "title": "  Soup  ",
  "source_url": "https://example.com/soup",
  "image_url": null,
  "prep_minutes": 10, "cook_minutes": 60, "total_minutes": 70,
  "servings": "6 to 8",
  "ingredients": [
    {"name": "pork", "quantity": 1.5, "unit": "lb", "raw_text": "1½ lb pork", "section": null},
    {"name": "stock", "quantity": 1, "unit": "qt", "raw_text": "1 qt stock", "section": "Broth"}
  ],
  "phases": [
    {"title": "", "intro": ["Read it through."], "steps": [
      {"id": null, "body": "Cube the pork.", "notes": []}
    ]},
    {"title": "Simmer", "intro": [], "steps": [
      {"id": null, "body": "Into the pot.", "notes": ["No salt yet."]},
      {"id": null, "body": "Skim.", "notes": []}
    ]}
  ]
}$json$::jsonb));

-- 7-13
select is((select title from public.dishes where id = (select id from tests.saved where key = 'dish')), 'Soup', 'create: title trimmed and stored');
select is((select household_id from public.dishes where id = (select id from tests.saved where key = 'dish')), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'create: household is the caller''s, never client-supplied');
select is((select created_by from public.dishes where id = (select id from tests.saved where key = 'dish')), 'a0000002-0000-0000-0000-000000000002'::uuid, 'create: created_by is the caller''s member id');
select is((select servings from public.dishes where id = (select id from tests.saved where key = 'dish')), '6 to 8', 'create: servings stored');
select is((select tags from public.dishes where id = (select id from tests.saved where key = 'dish')), '{}'::text[], 'create: omitted tags -> empty');
select is(
  (select array_agg(raw_text || '|' || coalesce(section, '-') || '|' || position order by position)
     from public.ingredients where dish_id = (select id from tests.saved where key = 'dish')),
  array['1½ lb pork|-|0', '1 qt stock|Broth|1'],
  'create: ingredients in order with sections');
select is(
  (select array_agg(title || '|' || position order by position)
     from public.dish_phases where dish_id = (select id from tests.saved where key = 'dish')),
  array['|0', 'Simmer|1'],
  'create: phases in order (untitled leading phase is '''')');

-- 14-15: steps numbered across the whole dish, each under its phase, notes kept
select is(
  (select array_agg(s.position || ':' || s.body || '@' || p.position order by s.position)
     from public.dish_steps s join public.dish_phases p on p.id = s.phase_id
    where s.dish_id = (select id from tests.saved where key = 'dish')),
  array['0:Cube the pork.@0', '1:Into the pot.@1', '2:Skim.@1'],
  'create: step positions are global across phases');
select is(
  (select notes from public.dish_steps where dish_id = (select id from tests.saved where key = 'dish') and position = 1),
  array['No salt yet.'],
  'create: step notes stored');

-- Remember the "Into the pot." step id, and set legacy description + tags
-- (privileged) to prove update leaves them alone.
insert into tests.saved (key, id)
  select 'pot', id from public.dish_steps where dish_id = (select id from tests.saved where key = 'dish') and body = 'Into the pot.';
insert into tests.saved (key, id)
  select 'cube', id from public.dish_steps where dish_id = (select id from tests.saved where key = 'dish') and body = 'Cube the pork.';
select tests.clear_auth();
update public.dishes set description = 'legacy markdown', tags = '{soup}' where id = (select id from tests.saved where key = 'dish');

-- ---------------------------------------------------------------------------
-- Update by id
-- ---------------------------------------------------------------------------
-- The update payload, built from ids saved above (created as the privileged role).
create or replace function tests.update_payload() returns jsonb language sql as $fn$
  select jsonb_build_object(
    'id', (select id from tests.saved where key = 'dish'),
    'title', 'Soup v2',
    'source_url', null, 'image_url', null,
    'prep_minutes', null, 'cook_minutes', null, 'total_minutes', null,
    'servings', null,
    'ingredients', '[{"name": "pork", "quantity": 2, "unit": "lb", "raw_text": "2 lb pork", "section": null}]'::jsonb,
    'phases', jsonb_build_array(
      jsonb_build_object('title', 'Prep', 'intro', '[]'::jsonb, 'steps', jsonb_build_array(
        jsonb_build_object('id', null, 'body', 'Oven on.', 'notes', '[]'::jsonb),
        jsonb_build_object('id', (select id from tests.saved where key = 'pot'), 'body', 'Into the pot.', 'notes', '["Still no salt."]'::jsonb)
      ))
    )
  );
$fn$;
grant execute on function tests.update_payload() to authenticated;

select tests.authenticate_as('11111111-1111-1111-1111-111111111111');

-- 16: update returns the same id (no duplicate dish)
select is(public.save_recipe(tests.update_payload()), (select id from tests.saved where key = 'dish'), 'update: returns the same dish id');

-- 17-26
select is((select count(*)::int from public.dishes where household_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'), 1, 'update: no new dish was created');
select is((select title from public.dishes where id = (select id from tests.saved where key = 'dish')), 'Soup v2', 'update: title replaced');
select is((select servings from public.dishes where id = (select id from tests.saved where key = 'dish')), null, 'update: servings replaced (cleared)');
select is((select tags from public.dishes where id = (select id from tests.saved where key = 'dish')), '{soup}'::text[], 'update: omitted tags are left unchanged');
select is((select description from public.dishes where id = (select id from tests.saved where key = 'dish')), 'legacy markdown', 'update: description is never written');
select is(
  (select array_agg(raw_text order by position) from public.ingredients where dish_id = (select id from tests.saved where key = 'dish')),
  array['2 lb pork'],
  'update: ingredients replaced');
select is(
  (select array_agg(title order by position) from public.dish_phases where dish_id = (select id from tests.saved where key = 'dish')),
  array['Prep'],
  'update: phases replaced');
select is(
  (select position from public.dish_steps where id = (select id from tests.saved where key = 'pot')),
  1,
  'update: a kept step keeps its id and takes its new position');
select is(
  (select notes from public.dish_steps where id = (select id from tests.saved where key = 'pot')),
  array['Still no salt.'],
  'update: a kept step''s notes are rewritten');
select is(
  (select count(*)::int from public.dish_steps where id = (select id from tests.saved where key = 'cube')),
  0,
  'update: a step missing from the input (stale) is deleted');

-- 27: the new step got a fresh id at position 0; 28: the deferred uniqueness holds
select is(
  (select array_agg(body order by position) from public.dish_steps where dish_id = (select id from tests.saved where key = 'dish')),
  array['Oven on.', 'Into the pot.'],
  'update: steps are exactly the input, in order');
select lives_ok($$set constraints all immediate$$, 'update: positions are unique once the deferred check runs');
set constraints all deferred;

-- ---------------------------------------------------------------------------
-- Tags given on update; idempotency + cross-household
-- ---------------------------------------------------------------------------
-- 29-30
select is(
  public.save_recipe(tests.update_payload() || '{"tags": ["dinner", "soup"]}'::jsonb),
  (select id from tests.saved where key = 'dish'),
  'update: a second save by id is idempotent (same id)');
select is((select tags from public.dishes where id = (select id from tests.saved where key = 'dish')), '{dinner,soup}'::text[], 'update: tags replaced when given');

-- 31-32: another household's dish id -> P0002, nothing written
select throws_ok(
  $$select public.save_recipe('{"id": "0d000002-0000-0000-0000-000000000002", "title": "pwned", "ingredients": [], "phases": []}'::jsonb)$$,
  'P0002', null, 'update: another household''s dish id -> P0002 (recipe not found)');
select throws_ok(
  $$select public.save_recipe('{"id": "0d0000ff-0000-0000-0000-0000000000ff", "title": "ghost", "ingredients": [], "phases": []}'::jsonb)$$,
  'P0002', null, 'update: an unknown dish id -> P0002, never a create');

-- 33: a step id from another household cannot be hijacked
select throws_ok(
  format($$select public.save_recipe(%L::jsonb)$$, jsonb_build_object(
    'id', (select id from tests.saved where key = 'dish'), 'title', 'Soup v3', 'ingredients', '[]'::jsonb,
    'phases', jsonb_build_array(jsonb_build_object('title', '', 'intro', '[]'::jsonb, 'steps', jsonb_build_array(
      jsonb_build_object('id', '05000002-0000-0000-0000-000000000002', 'body', 'Hijack.', 'notes', '[]'::jsonb))))
  )::text),
  '42501', null, 'update: another household''s step id is refused by RLS');

-- 34-35: validation
select throws_ok(
  $$select public.save_recipe('{"title": "   ", "ingredients": [], "phases": []}'::jsonb)$$,
  '22023', null, 'validation: a blank title is rejected');
select throws_ok(
  $$select public.save_recipe('{"title": "Blank step", "ingredients": [], "phases": [{"title": "", "intro": [], "steps": [{"id": null, "body": "  ", "notes": []}]}]}'::jsonb)$$,
  '23514', null, 'validation: a blank step body is rejected');

select tests.clear_auth();

-- 36-38: nothing leaked into K, and the failed calls wrote nothing
select is((select title from public.dishes where id = '0d000002-0000-0000-0000-000000000002'), 'K Tacos', 'cross-household: K''s dish untouched');
select is((select body || '@' || dish_id from public.dish_steps where id = '05000002-0000-0000-0000-000000000002'), 'Warm the tortillas.@0d000002-0000-0000-0000-000000000002', 'cross-household: K''s step untouched');
select is(
  (select count(*)::int from public.dishes where title in ('pwned', 'ghost', 'Blank step', '   ')),
  0,
  'failed saves wrote nothing (atomic)');

select * from finish();
rollback;
