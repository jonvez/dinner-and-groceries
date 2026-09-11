-- "We have it" takes the item off the shopping list (issue #171, ADR 0012).
--
-- The claim gets its OWN stamp rather than reusing `purchased_at`. Reusing the
-- archive stamp would be cheaper by one column and wrong in two ways: it would
-- write a phantom PURCHASE into the trip history the dashboard (#17) reads, and
-- it would feed `completeTrip`'s staples-promotion offer. "We have it" is a
-- pantry fact, not a purchase.
--
-- The row STAYS on the table, un-purchased, so the roll-up planner
-- (`lib/grocery/rollup.ts`) keeps seeing it and it keeps claiming its dedupe
-- key — a "Rebuild from menu" must not be able to insert a shadow duplicate of
-- something the family just said they already had. Only the shopping-list READ
-- (`loadGroceryList`) hides it. Hiding a row from the display and removing it
-- from the planner's `existing` set are two different things; only the first is
-- wanted.
--
-- `have_it` (the boolean) stays: it is what the planner's protection rule reads,
-- and the two are written together in ONE statement by `setHaveIt`, never apart.
alter table public.grocery_items
  add column have_it_at timestamptz;

comment on column public.grocery_items.have_it_at is
  'When the family said they already have this (#171). Set => hidden from the shopping list, but still on the table and still claiming its dedupe key for the roll-up. NOT a purchase: cleared by the next completed trip, never stamped into trip history.';

-- Rows already flagged "we have it" ARE claims — the family has already said so,
-- and the whole point of #171 is that saying so takes the item off the list. Give
-- them the stamp so behaviour is consistent the moment this deploys instead of
-- leaving a handful of greyed-out rows that only this migration's absence
-- explains. Archived rows are untouched: they are history, and a stamp there
-- would be a claim on a row nothing reads.
update public.grocery_items
  set have_it_at = now()
  where have_it and purchased_at is null;

-- The active-list read is `purchased_at is null and have_it_at is null`, scoped
-- by RLS to one household. This partial index matches it exactly.
create index grocery_items_active_idx
  on public.grocery_items (household_id)
  where purchased_at is null and have_it_at is null;

-- RLS: nothing to add. Every policy on this table is ROW-level on `household_id`
-- (see 20260807151528_grocery_items_schema.sql) — select/insert/update/delete all
-- test `household_id = public.current_household_id()`, with the update policy
-- repeating it in WITH CHECK — so a new column is covered by the existing
-- allow/deny matrix by construction, with no column-level grants anywhere to
-- widen. There is no new grant here either: `authenticated` already holds
-- update on the table, and every write still runs as the signed-in user (no
-- service-role path). supabase/tests/19_grocery_items_rls_test.sql is extended
-- to PROVE that for this column rather than assume it.
