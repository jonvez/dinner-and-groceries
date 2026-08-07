-- catalog_items — a household's reusable staples (issue #13, Slice 1d). Top-level
-- household child (like dishes): the catalog a grocery item can be promoted from
-- or fed by. `added_count`/`last_added_at` are kept (not surfaced in MVP) so
-- repurchase suggestions are possible later. No cost/price columns (SPEC.md).
-- Names dedupe case-insensitively per household so "Olive oil" and "olive oil"
-- are one staple.
create table public.catalog_items (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households (id) on delete cascade,
  name          text not null,
  default_unit  text,
  category      text,
  last_added_at timestamptz,
  added_count   integer not null default 0,
  created_at    timestamptz not null default now(),
  constraint catalog_items_name_not_blank check (length(btrim(name)) > 0),
  -- Enables composite (id, household_id) FK references from future children.
  unique (id, household_id)
);

create index catalog_items_household_id_idx on public.catalog_items (household_id);
create unique index catalog_items_household_name_key
  on public.catalog_items (household_id, lower(name));

alter table public.catalog_items enable row level security;
alter table public.catalog_items force  row level security;

grant select, insert, update, delete on public.catalog_items to authenticated;

-- Every catalog item is shared household data: any authenticated member of the
-- household may read/write its rows. Direct household_id check (ADR 0003 — no
-- parent join). UPDATE repeats the check in WITH CHECK so a row can't be moved
-- to another household.
create policy catalog_items_select on public.catalog_items
  for select to authenticated
  using (household_id = public.current_household_id());
create policy catalog_items_insert on public.catalog_items
  for insert to authenticated
  with check (household_id = public.current_household_id());
create policy catalog_items_update on public.catalog_items
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());
create policy catalog_items_delete on public.catalog_items
  for delete to authenticated
  using (household_id = public.current_household_id());
