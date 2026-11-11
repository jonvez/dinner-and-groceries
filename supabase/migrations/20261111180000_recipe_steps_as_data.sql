-- Migration: recipe_steps_as_data (issue #272)
-- Design of record: docs/superpowers/specs/2026-11-11-recipe-steps-as-data-design.md
--
-- Makes a recipe's method real data instead of markdown parsed on every render:
--   * dish_phases / dish_steps tables (ADR 0003 shape: household_id denormalized,
--     composite FK to dishes, FORCE RLS, the four household policies);
--   * ingredients.section (ingredient groups) and dishes.servings;
--   * public.save_recipe(jsonb): ONE atomic, SECURITY INVOKER write path for a
--     whole recipe, so RLS does all the scoping (no definer, no service role);
--   * a one-shot backfill of legacy `dishes.description` methods into rows.
--
-- EXPAND-ONLY (ADR 0015). Prod migrations apply from CI before the new app
-- container is live, so the deployed app keeps reading `dishes.description`
-- during the deploy window. Nothing here drops, renames or rewrites an existing
-- column; `description` is left exactly as it is (a later contract migration can
-- null it once no deployed app reads it).

-- ===========================================================================
-- 1. Expand existing tables
-- ===========================================================================
-- Ingredient group label ("Filling", "Topping"). null = ungrouped.
alter table public.ingredients add column section text;
-- Free-text yield ("6 to 8", "1 loaf"). null = unknown.
alter table public.dishes add column servings text;

-- ===========================================================================
-- 2. dish_phases — a stretch of the cook ("While the pork simmers")
-- ===========================================================================
create table public.dish_phases (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  dish_id      uuid not null,
  -- 0-based order within the dish.
  position     integer not null,
  -- '' = the untitled leading phase (steps written before any heading).
  title        text not null default '',
  -- Phase-level intro lines / notes.
  intro        text[] not null default '{}',
  created_at   timestamptz not null default now(),
  foreign key (dish_id, household_id)
    references public.dishes (id, household_id) on delete cascade,
  -- Target for dish_steps' (phase_id, dish_id) FK: a step's phase must belong
  -- to the step's own dish.
  unique (id, dish_id),
  -- Deferred so save_recipe can insert a dish's new phases (positions 0..n)
  -- before it deletes the old ones, inside one transaction.
  constraint dish_phases_dish_position_key unique (dish_id, position)
    deferrable initially deferred
);

create index dish_phases_household_id_idx on public.dish_phases (household_id);
-- (dish_id leads the unique (dish_id, position) index, which serves dish_id lookups.)

-- ===========================================================================
-- 3. dish_steps — one step of the method, with a STABLE id
-- ===========================================================================
-- Cook progress is keyed by step id, and save_recipe keeps the ids of steps a
-- revision didn't change, so an edit made mid-cook never scrambles progress.
create table public.dish_steps (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  dish_id      uuid not null,
  phase_id     uuid not null,
  -- 0-based order across the WHOLE dish (display number = position + 1).
  position     integer not null,
  body         text not null check (length(trim(body)) > 0),
  notes        text[] not null default '{}',
  created_at   timestamptz not null default now(),
  foreign key (dish_id, household_id)
    references public.dishes (id, household_id) on delete cascade,
  -- The phase must be one of THIS dish's phases (not just any phase).
  foreign key (phase_id, dish_id)
    references public.dish_phases (id, dish_id) on delete cascade,
  -- Deferred so a reorder (kept steps changing places) is legal mid-transaction.
  constraint dish_steps_dish_position_key unique (dish_id, position)
    deferrable initially deferred
);

create index dish_steps_household_id_idx on public.dish_steps (household_id);
create index dish_steps_phase_id_idx     on public.dish_steps (phase_id);
-- (dish_id leads the unique (dish_id, position) index, which serves dish_id lookups.)

-- ===========================================================================
-- 4. RLS + grants (mirrors public.ingredients)
-- ===========================================================================
alter table public.dish_phases enable row level security;
alter table public.dish_phases force  row level security;
alter table public.dish_steps  enable row level security;
alter table public.dish_steps  force  row level security;

-- Default privileges grant these roles nothing on new tables (#140); grant
-- back exactly the four the app uses.
grant select, insert, update, delete on public.dish_phases to authenticated;
grant select, insert, update, delete on public.dish_steps  to authenticated;

-- Shared household data: any member reads/writes the household's rows. Direct
-- household_id check (ADR 0003, no parent join). UPDATE repeats the check in
-- WITH CHECK so a row can't be moved to another household.
create policy dish_phases_select on public.dish_phases
  for select to authenticated
  using (household_id = public.current_household_id());
create policy dish_phases_insert on public.dish_phases
  for insert to authenticated
  with check (household_id = public.current_household_id());
create policy dish_phases_update on public.dish_phases
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());
create policy dish_phases_delete on public.dish_phases
  for delete to authenticated
  using (household_id = public.current_household_id());

create policy dish_steps_select on public.dish_steps
  for select to authenticated
  using (household_id = public.current_household_id());
create policy dish_steps_insert on public.dish_steps
  for insert to authenticated
  with check (household_id = public.current_household_id());
create policy dish_steps_update on public.dish_steps
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());
create policy dish_steps_delete on public.dish_steps
  for delete to authenticated
  using (household_id = public.current_household_id());

-- ===========================================================================
-- 5. save_recipe(p_recipe jsonb) -> dish id
-- ===========================================================================
-- The one write path for a whole recipe (the add form today; the MCP companion
-- and the edit UI next). All of it runs in the caller's transaction, so it
-- either all lands or none of it does.
--
-- SECURITY INVOKER: every statement runs as the caller under RLS. The function
-- adds no privilege; it only bundles writes the caller could already make.
-- Household and author come from the session, never from the payload.
--
-- Input (positions are never client-supplied; array order is the order):
--   { id: uuid|null, title, source_url, image_url, prep_minutes, cook_minutes,
--     total_minutes, servings, tags?: text[],
--     ingredients: [{ name, quantity, unit, raw_text, section }],
--     phases: [{ title, intro: [..], steps: [{ id: uuid|null, body, notes: [..] }] }] }
--
-- id null  -> create. id present -> replace that dish's content, or raise
-- P0002 if no such dish is visible (bad id, or another household's). It NEVER
-- creates on a bad id: a caller holding an id updates or fails, never
-- duplicates. `tags` omitted leaves tags unchanged on update ('{}' on create);
-- `ingredients`/`phases` omitted mean empty. `description` is never written.
create function public.save_recipe(p_recipe jsonb)
returns uuid
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_household_id uuid := (select public.current_household_id());
  v_member_id    uuid;
  v_dish_id      uuid;
  v_title        text;
  v_tags         text[];
  v_ingredients  jsonb := coalesce(nullif(p_recipe -> 'ingredients', 'null'::jsonb), '[]'::jsonb);
  v_phases       jsonb := coalesce(nullif(p_recipe -> 'phases', 'null'::jsonb), '[]'::jsonb);
  v_kept_ids     uuid[];
  v_new_phases   uuid[] := '{}';
  v_phase        record;
  v_step         record;
  v_phase_id     uuid;
  v_position     integer := 0;
begin
  if jsonb_typeof(p_recipe) is distinct from 'object' then
    raise exception 'save_recipe: recipe must be a json object' using errcode = '22023';
  end if;

  -- Identity from the verified session only.
  select m.id into v_member_id from public.members m where m.user_id = (select auth.uid());
  if v_household_id is null or v_member_id is null then
    raise exception 'save_recipe: not authenticated' using errcode = '28000';
  end if;

  v_title := btrim(coalesce(p_recipe ->> 'title', ''));
  if v_title = '' then
    raise exception 'save_recipe: title is required' using errcode = '22023';
  end if;
  if jsonb_typeof(v_ingredients) <> 'array' or jsonb_typeof(v_phases) <> 'array' then
    raise exception 'save_recipe: ingredients and phases must be arrays' using errcode = '22023';
  end if;
  if jsonb_typeof(p_recipe -> 'tags') = 'array' then
    v_tags := array(select jsonb_array_elements_text(p_recipe -> 'tags'));
  end if;

  -- Step ids the caller is keeping. A duplicate would make one step two.
  select coalesce(array_agg((s.value ->> 'id')::uuid), '{}')
    into v_kept_ids
    from jsonb_array_elements(v_phases) p,
         jsonb_array_elements(coalesce(nullif(p.value -> 'steps', 'null'::jsonb), '[]'::jsonb)) s
   where s.value ->> 'id' is not null;
  if cardinality(v_kept_ids) <> (select count(distinct k) from unnest(v_kept_ids) k) then
    raise exception 'save_recipe: duplicate step id' using errcode = '22023';
  end if;

  -- 1. The dish row.
  if p_recipe ->> 'id' is null then
    insert into public.dishes (
      household_id, title, source_url, image_url,
      prep_minutes, cook_minutes, total_minutes, servings, tags, created_by
    ) values (
      v_household_id,
      v_title,
      nullif(btrim(p_recipe ->> 'source_url'), ''),
      nullif(btrim(p_recipe ->> 'image_url'), ''),
      (p_recipe ->> 'prep_minutes')::integer,
      (p_recipe ->> 'cook_minutes')::integer,
      (p_recipe ->> 'total_minutes')::integer,
      nullif(btrim(p_recipe ->> 'servings'), ''),
      coalesce(v_tags, '{}'),
      v_member_id
    )
    returning id into v_dish_id;
  else
    -- A malformed id is just another id that matches nothing.
    if (p_recipe ->> 'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'save_recipe: recipe not found' using errcode = 'P0002';
    end if;
    update public.dishes d set
      title         = v_title,
      source_url    = nullif(btrim(p_recipe ->> 'source_url'), ''),
      image_url     = nullif(btrim(p_recipe ->> 'image_url'), ''),
      prep_minutes  = (p_recipe ->> 'prep_minutes')::integer,
      cook_minutes  = (p_recipe ->> 'cook_minutes')::integer,
      total_minutes = (p_recipe ->> 'total_minutes')::integer,
      servings      = nullif(btrim(p_recipe ->> 'servings'), ''),
      tags          = coalesce(v_tags, d.tags)
    where d.id = (p_recipe ->> 'id')::uuid
    returning d.id, d.household_id into v_dish_id, v_household_id;
    -- RLS hides another household's dish, so it lands here too.
    if v_dish_id is null then
      raise exception 'save_recipe: recipe not found' using errcode = 'P0002';
    end if;
  end if;

  -- 2. Ingredients: replaced wholesale (nothing references their ids yet).
  delete from public.ingredients where dish_id = v_dish_id;
  insert into public.ingredients (household_id, dish_id, name, quantity, unit, raw_text, section, position)
  select v_household_id,
         v_dish_id,
         e.value ->> 'name',
         (e.value ->> 'quantity')::numeric,
         nullif(e.value ->> 'unit', ''),
         coalesce(e.value ->> 'raw_text', e.value ->> 'name'),
         nullif(btrim(e.value ->> 'section'), ''),
         (e.ord - 1)::integer
    from jsonb_array_elements(v_ingredients) with ordinality as e(value, ord);

  -- 3. Method. Order matters for the FKs:
  --    a. delete this dish's steps the input no longer has (stale);
  --    b. insert the new phases (old ones still exist; the position unique is
  --       deferred) and upsert every step onto its new phase + position;
  --    c. delete the old phases, which by now no step references.
  delete from public.dish_steps s
   where s.dish_id = v_dish_id
     and s.id <> all (v_kept_ids);

  for v_phase in
    select p.value, (p.ord - 1)::integer as pos
      from jsonb_array_elements(v_phases) with ordinality as p(value, ord)
     order by p.ord
  loop
    insert into public.dish_phases (household_id, dish_id, position, title, intro)
    values (
      v_household_id,
      v_dish_id,
      v_phase.pos,
      btrim(coalesce(v_phase.value ->> 'title', '')),
      array(select jsonb_array_elements_text(
        coalesce(nullif(v_phase.value -> 'intro', 'null'::jsonb), '[]'::jsonb)))
    )
    returning id into v_phase_id;
    v_new_phases := v_new_phases || v_phase_id;

    for v_step in
      select s.value
        from jsonb_array_elements(
               coalesce(nullif(v_phase.value -> 'steps', 'null'::jsonb), '[]'::jsonb))
             with ordinality as s(value, ord)
       order by s.ord
    loop
      -- A kept id is upserted: RLS on the UPDATE arm refuses another
      -- household's step (an error, not a silent skip), and the row is
      -- rewritten onto this dish/phase/position.
      insert into public.dish_steps (id, household_id, dish_id, phase_id, position, body, notes)
      values (
        coalesce((v_step.value ->> 'id')::uuid, gen_random_uuid()),
        v_household_id,
        v_dish_id,
        v_phase_id,
        v_position,
        btrim(v_step.value ->> 'body'),
        array(select jsonb_array_elements_text(
          coalesce(nullif(v_step.value -> 'notes', 'null'::jsonb), '[]'::jsonb)))
      )
      on conflict (id) do update set
        household_id = excluded.household_id,
        dish_id      = excluded.dish_id,
        phase_id     = excluded.phase_id,
        position     = excluded.position,
        body         = excluded.body,
        notes        = excluded.notes;
      v_position := v_position + 1;
    end loop;
  end loop;

  delete from public.dish_phases p
   where p.dish_id = v_dish_id
     and p.id <> all (v_new_phases);

  return v_dish_id;
end;
$$;

-- Authenticated callers only. (Functions are executable by PUBLIC by default.)
revoke all on function public.save_recipe(jsonb) from public, anon;
grant execute on function public.save_recipe(jsonb) to authenticated;

-- ===========================================================================
-- 6. Backfill legacy description methods into rows
-- ===========================================================================
-- Parses a dish's `description` with the SAME rules as the app's parseMethod
-- (lib/recipes/method-parse.ts), and inserts its phases and steps with the
-- dish's own household_id:
--   * trim each line (JS String.prototype.trim: whitespace incl. NBSP / BOM);
--     skip blank lines
--   * "## " opens a phase (title = the rest, trimmed)
--   * /^\d+\.\s+/ is a step (the author's numbers are ignored)
--   * /^[-*]\s+/ is a note on the current phase's last step, or a phase intro
--     line when the phase has no step yet
--   * any other line is an intro line
--   * anything before the first heading goes into an untitled ('') phase
-- A dish that already has phases is skipped, so this is safe to re-run.
--
-- Kept (not dropped) so supabase/tests/26_backfill_parity_test.sql can pin it to
-- parseMethod. It is SECURITY INVOKER and executable by NO client role: only
-- the migration owner runs it, which bypasses RLS by design for this one-shot,
-- dish-scoped data migration.
create function public._backfill_dish_method(p_dish_id uuid)
returns void
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  c_trim  constant text := '^[\s ﻿]+|[\s ﻿]+$';
  v_dish  record;
  v_line  text;
  v_match text;
  v_phases jsonb := '[]'::jsonb;  -- [{title, intro: [], steps: [{body, notes: []}]}]
  v_last  integer;                -- index of the current phase
  v_steps integer;                -- step count of the current phase
  v_phase record;
  v_step  record;
  v_phase_id uuid;
  v_position integer := 0;
begin
  select d.id, d.household_id, d.description
    into v_dish
    from public.dishes d
   where d.id = p_dish_id;
  if v_dish.id is null
     or v_dish.description is null
     or exists (select 1 from public.dish_phases p where p.dish_id = p_dish_id) then
    return;
  end if;

  for v_line in
    select regexp_replace(l.line, c_trim, '', 'g')
      from unnest(string_to_array(v_dish.description, E'\n')) with ordinality as l(line, ord)
     order by l.ord
  loop
    continue when v_line = '';

    if starts_with(v_line, '## ') then
      v_phases := v_phases || jsonb_build_array(jsonb_build_object(
        'title', regexp_replace(substr(v_line, 4), c_trim, '', 'g'),
        'intro', '[]'::jsonb,
        'steps', '[]'::jsonb));
      continue;
    end if;

    -- Every other kind of line belongs to a phase: open the untitled one.
    if jsonb_array_length(v_phases) = 0 then
      v_phases := jsonb_build_array(jsonb_build_object(
        'title', '', 'intro', '[]'::jsonb, 'steps', '[]'::jsonb));
    end if;
    v_last  := jsonb_array_length(v_phases) - 1;
    v_steps := jsonb_array_length(v_phases -> v_last -> 'steps');

    v_match := substring(v_line from '^[0-9]+\.\s+(.*)$');
    if v_match is not null then
      v_phases := jsonb_set(v_phases, array[v_last::text, 'steps'],
        (v_phases -> v_last -> 'steps')
          || jsonb_build_array(jsonb_build_object(
               'body', regexp_replace(v_match, c_trim, '', 'g'),
               'notes', '[]'::jsonb)));
      continue;
    end if;

    v_match := substring(v_line from '^[-*]\s+(.*)$');
    if v_match is not null and v_steps > 0 then
      v_phases := jsonb_set(v_phases, array[v_last::text, 'steps', (v_steps - 1)::text, 'notes'],
        (v_phases -> v_last -> 'steps' -> (v_steps - 1) -> 'notes')
          || to_jsonb(regexp_replace(v_match, c_trim, '', 'g')));
      continue;
    end if;

    v_phases := jsonb_set(v_phases, array[v_last::text, 'intro'],
      (v_phases -> v_last -> 'intro')
        || to_jsonb(coalesce(regexp_replace(v_match, c_trim, '', 'g'), v_line)));
  end loop;

  for v_phase in
    select p.value, (p.ord - 1)::integer as pos
      from jsonb_array_elements(v_phases) with ordinality as p(value, ord)
     order by p.ord
  loop
    insert into public.dish_phases (household_id, dish_id, position, title, intro)
    values (
      v_dish.household_id,
      v_dish.id,
      v_phase.pos,
      v_phase.value ->> 'title',
      array(select jsonb_array_elements_text(v_phase.value -> 'intro'))
    )
    returning id into v_phase_id;

    for v_step in
      select s.value
        from jsonb_array_elements(v_phase.value -> 'steps') with ordinality as s(value, ord)
       order by s.ord
    loop
      insert into public.dish_steps (household_id, dish_id, phase_id, position, body, notes)
      values (
        v_dish.household_id,
        v_dish.id,
        v_phase_id,
        v_position,
        v_step.value ->> 'body',
        array(select jsonb_array_elements_text(v_step.value -> 'notes'))
      );
      v_position := v_position + 1;
    end loop;
  end loop;
end;
$$;

revoke all on function public._backfill_dish_method(uuid) from public, anon, authenticated;

-- Run it for every dish that has a non-blank legacy method and no rows yet
-- (in prod: the cilantro lime soup and the no-boil rigatoni).
do $$
declare
  r record;
begin
  for r in
    select d.id
      from public.dishes d
     where d.description ~ '\S'
       and not exists (select 1 from public.dish_phases p where p.dish_id = d.id)
  loop
    perform public._backfill_dish_method(r.id);
    raise notice 'backfilled method for dish %', r.id;
  end loop;
end $$;
