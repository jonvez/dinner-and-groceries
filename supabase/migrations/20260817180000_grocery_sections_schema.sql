-- Migration: grocery_sections (issue #136, epic #135)
--
-- Sections group the shopping list into store-aisle order (Produce, Dairy,
-- Frozen, Household...). They replace a manual habit rather than encoding one:
-- the family's prior list used unlabeled "______" separator rows that were
-- re-sorted BY HAND on every shopping trip and recorded no category at all.
--
-- Two pointers, deliberately different in kind:
--   * `catalog_items.section_id` is the DURABLE assignment — the staple's home
--     aisle. Correct it once and it stays correct.
--   * `grocery_items.section_id` is a SNAPSHOT copied at add-time, so a row can
--     be sectioned regardless of provenance (dish-derived rows and ad-hoc typed
--     rows have no catalog row to inherit from at read time).
--
-- Both use the composite `(section_id, household_id)` FK pattern established in
-- grocery_items_schema.sql, so a section pointer can only ever name a row in the
-- SAME household — a cross-household pointer is unstorable by construction, not
-- merely unreadable via RLS. Both use the PG15+ column-list ON DELETE SET NULL
-- so deleting a section drops the pointer while leaving the NOT NULL
-- household_id intact, rather than deleting the shopper's items.

create table public.grocery_sections (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  name         text not null,
  -- Sort key for aisle order. Sparse (10, 20, 30...) so a section can be moved
  -- between two others without renumbering the whole household's set.
  position     integer not null default 0,
  created_at   timestamptz not null default now(),
  constraint grocery_sections_name_not_blank check (length(btrim(name)) > 0),
  -- Enables the composite (id, household_id) FK references below.
  unique (id, household_id)
);

create index grocery_sections_household_id_idx
  on public.grocery_sections (household_id);
-- Names dedupe case-insensitively per household, matching catalog_items, so
-- "Frozen" and "frozen" cannot both exist and split one aisle in two.
create unique index grocery_sections_household_name_key
  on public.grocery_sections (household_id, lower(name));
create index grocery_sections_household_position_idx
  on public.grocery_sections (household_id, position);

alter table public.grocery_sections enable row level security;
alter table public.grocery_sections force  row level security;

-- Supabase's project-wide default privileges grant effectively ALL (including
-- TRUNCATE, which bypasses RLS and is a bulk delete) to anon/authenticated on
-- every NEW public table. Issue #49 revoked that table by table but explicitly
-- left `alter default privileges` out of scope, so a table created today
-- inherits the leak again. Revoke first, then grant back only what the app
-- needs — the same shape events_schema.sql uses. anon gets nothing.
revoke all on public.grocery_sections from anon, authenticated;
grant select, insert, update, delete on public.grocery_sections to authenticated;

-- Sections are shared household data: any member may read and reorganize them
-- (the kids shop too). Direct household_id check (ADR 0003 — no parent join).
-- UPDATE repeats the check in WITH CHECK so a row can't be re-homed.
create policy grocery_sections_select on public.grocery_sections
  for select to authenticated
  using (household_id = public.current_household_id());
create policy grocery_sections_insert on public.grocery_sections
  for insert to authenticated
  with check (household_id = public.current_household_id());
create policy grocery_sections_update on public.grocery_sections
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());
create policy grocery_sections_delete on public.grocery_sections
  for delete to authenticated
  using (household_id = public.current_household_id());

-- ---------------------------------------------------------------------------
-- Section pointers
-- ---------------------------------------------------------------------------

alter table public.catalog_items
  add column section_id uuid,
  add constraint catalog_items_section_id_fkey
    foreign key (section_id, household_id)
    references public.grocery_sections (id, household_id)
    on delete set null (section_id);

create index catalog_items_section_id_idx on public.catalog_items (section_id);

alter table public.grocery_items
  add column section_id uuid,
  add constraint grocery_items_section_id_fkey
    foreign key (section_id, household_id)
    references public.grocery_sections (id, household_id)
    on delete set null (section_id);

create index grocery_items_section_id_idx on public.grocery_items (section_id);

-- ---------------------------------------------------------------------------
-- Retire the placeholder `category` column
-- ---------------------------------------------------------------------------
-- catalog_items.category was reserved in the original slice-1d schema and never
-- read or written by any application code path. `section_id` is now the real
-- thing, and keeping both would leave two ways to say the same thing.
--
-- Guarded rather than trusted: if any row ever did carry a category, this
-- migration ABORTS instead of silently discarding it. A loud failure on the
-- manual prod push is the correct outcome; data loss is not.
do $$
begin
  if exists (select 1 from public.catalog_items where category is not null) then
    raise exception
      'catalog_items.category holds data (% row(s)) — refusing to drop it; migrate the values to section_id first',
      (select count(*) from public.catalog_items where category is not null);
  end if;
end $$;

alter table public.catalog_items drop column category;

-- ---------------------------------------------------------------------------
-- Default sections for every household, now and in future
-- ---------------------------------------------------------------------------
-- Aisle order, with Unsorted deliberately LAST so uncategorized items collect at
-- the bottom of the list instead of interrupting the shop. The non-food sections
-- are not padding: the family's real history includes windex, gulfwax, sidewalk
-- salt, aleve, and acrylic paint. Every name is renameable in-app; this is a
-- starting point, not a fixed taxonomy.
create function public.default_grocery_sections()
returns table (name text, position integer)
language sql
immutable
as $$
  select * from (values
    ('Produce',         10),
    ('Meat & Seafood',  20),
    ('Dairy & Eggs',    30),
    ('Bakery',          40),
    ('Frozen',          50),
    ('Pantry',          60),
    ('Beverages',       70),
    ('Snacks',          80),
    ('Household',       90),
    ('Pharmacy',       100),
    ('Unsorted',       110)
  ) as s(name, position);
$$;

-- Seeded by trigger rather than inside create_household() so that EVERY path
-- which creates a household gets sections, without this migration having to
-- restate that SECURITY DEFINER function's whole body.
--
-- SECURITY DEFINER because the rows are written in the same statement that
-- creates the household, before the caller has a members row for
-- current_household_id() to resolve — the same chicken-and-egg the bootstrap
-- functions solve. The surface is tight: it takes no user input, reads only
-- NEW.id, and writes a fixed constant set. `set search_path = ''` and full
-- schema qualification match the conventions in household_bootstrap.sql.
create function public.seed_default_grocery_sections()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.grocery_sections (household_id, name, position)
  select new.id, d.name, d.position
  from public.default_grocery_sections() as d;
  return new;
end;
$$;

create trigger households_seed_grocery_sections
  after insert on public.households
  for each row
  execute function public.seed_default_grocery_sections();

-- Backfill households that already exist. `on conflict do nothing` keeps this
-- re-runnable and harmless if a household somehow already has a section.
insert into public.grocery_sections (household_id, name, position)
select h.id, d.name, d.position
from public.households h
cross join public.default_grocery_sections() as d
on conflict do nothing;
