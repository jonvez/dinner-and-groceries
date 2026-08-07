-- grocery_items — the week's shopping list (issue #13, Slice 1d). Child of weeks;
-- household_id denormalized (ADR 0003) + composite FK so a list row is always in
-- the same household as its week. Three feeders, none mandatory: from a dish
-- (`ingredient_id`), from the staples catalog (`catalog_item_id`), or ad-hoc
-- (both null). Both feeder FKs are composite `(x, household_id)` like every other
-- inter-table FK here, so a provenance pointer can only ever name a row in the
-- *same* household — a cross-household pointer is unstorable by construction, not
-- merely unreadable via RLS. They use the PG15+ column-list ON DELETE SET NULL
-- (see social_schema.sql) so deleting a source ingredient or catalog staple drops
-- the provenance while leaving the NOT NULL household_id intact — never removing a
-- row the shopper is standing in the store with. MATCH SIMPLE means a NULL feeder
-- skips the check entirely, so ad-hoc rows still insert freely.
--
-- catalog_items already exposes `unique (id, household_id)`; ingredients does not,
-- so add it here (additive, before the table that references it).
alter table public.ingredients
  add constraint ingredients_id_household_key unique (id, household_id);

--
-- quantity/unit are optional (nullable) — "bananas" needs no number. `edited`
-- flags a hand-edited row so re-roll-up (#14) leaves it alone; `purchased_at`
-- soft-archives a bought row (active list = purchased_at is null). No cost or
-- price columns (out of MVP scope, SPEC.md).
create table public.grocery_items (
  id              uuid primary key default gen_random_uuid(),
  household_id    uuid not null,
  week_id         uuid not null,
  name            text not null,
  quantity        numeric,
  unit            text,
  ingredient_id   uuid,
  catalog_item_id uuid,
  have_it         boolean not null default false,
  checked         boolean not null default false,
  edited          boolean not null default false,
  purchased_at    timestamptz,
  position        integer not null default 0,
  created_at      timestamptz not null default now(),
  constraint grocery_items_name_not_blank check (length(btrim(name)) > 0),
  foreign key (week_id, household_id)
    references public.weeks (id, household_id) on delete cascade,
  foreign key (ingredient_id, household_id)
    references public.ingredients (id, household_id) on delete set null (ingredient_id),
  foreign key (catalog_item_id, household_id)
    references public.catalog_items (id, household_id) on delete set null (catalog_item_id)
);

create index grocery_items_household_id_idx   on public.grocery_items (household_id);
create index grocery_items_week_id_idx        on public.grocery_items (week_id);
create index grocery_items_ingredient_id_idx  on public.grocery_items (ingredient_id);
create index grocery_items_catalog_item_id_idx on public.grocery_items (catalog_item_id);

alter table public.grocery_items enable row level security;
alter table public.grocery_items force  row level security;

grant select, insert, update, delete on public.grocery_items to authenticated;

-- The list is shared household data: any authenticated member of the household
-- may read/write its rows (kids check things off too). Direct household_id check
-- (ADR 0003 — no parent join). UPDATE repeats the check in WITH CHECK so a row
-- can't be moved to another household.
create policy grocery_items_select on public.grocery_items
  for select to authenticated
  using (household_id = public.current_household_id());
create policy grocery_items_insert on public.grocery_items
  for insert to authenticated
  with check (household_id = public.current_household_id());
create policy grocery_items_update on public.grocery_items
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());
create policy grocery_items_delete on public.grocery_items
  for delete to authenticated
  using (household_id = public.current_household_id());
