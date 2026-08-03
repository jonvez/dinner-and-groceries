-- ingredients — a dish's ingredient lines (issue #12b, Slice 1c). Child of dishes;
-- household_id denormalized (ADR 0003) + composite FK so an ingredient is always in
-- the same household as its dish. `raw_text` is always kept (nothing lost);
-- quantity/unit are nullable (count items, unparseable lines). ON DELETE CASCADE:
-- deleting a dish removes its ingredients.
create table public.ingredients (
  id           uuid primary key default gen_random_uuid(),
  household_id uuid not null,
  dish_id      uuid not null,
  name         text not null check (length(trim(name)) > 0),
  quantity     numeric,
  unit         text,
  raw_text     text not null,
  position     integer not null default 0,
  created_at   timestamptz not null default now(),
  foreign key (dish_id, household_id)
    references public.dishes (id, household_id) on delete cascade
);

create index ingredients_household_id_idx on public.ingredients (household_id);
create index ingredients_dish_id_idx      on public.ingredients (dish_id);

alter table public.ingredients enable row level security;
alter table public.ingredients force  row level security;

grant select, insert, update, delete on public.ingredients to authenticated;

-- Every ingredient is shared household data: any authenticated member of the
-- household may read/write its rows. Direct household_id check (ADR 0003 — no
-- parent join). UPDATE repeats the check in WITH CHECK so a row can't be moved
-- to another household.
create policy ingredients_select on public.ingredients
  for select to authenticated
  using (household_id = public.current_household_id());
create policy ingredients_insert on public.ingredients
  for insert to authenticated
  with check (household_id = public.current_household_id());
create policy ingredients_update on public.ingredients
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());
create policy ingredients_delete on public.ingredients
  for delete to authenticated
  using (household_id = public.current_household_id());
