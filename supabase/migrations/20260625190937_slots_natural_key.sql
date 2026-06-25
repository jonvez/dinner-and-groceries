-- Migration: slots_natural_key (slice 1b, issue #10)
--
-- Make a slot's NATURAL KEY unique so "find-or-create the slot for
-- (week_id, day_of_week, meal_type)" is idempotent. Issue #10's slotting does an
-- UPSERT on this key (insert ... on conflict do update); without a matching
-- unique constraint that upsert has no conflict target and concurrent taps /
-- re-renders could create DUPLICATE slots for the same board cell.
--
-- This mirrors the weeks table's `unique (household_id, start_date)` lazy-upsert
-- pattern (ADR 0003). `week_id` already implies `household_id` via the composite
-- (week_id, household_id) FK on slots, so the natural key needs no household_id —
-- a (week_id, day_of_week, meal_type) collision can only ever occur WITHIN one
-- household. The existing `unique (id, household_id)` (composite-FK target) and
-- the PK on id are unaffected.
--
-- RLS note: the upsert's ON CONFLICT DO UPDATE branch runs under the slots UPDATE
-- policy (using + with check on household_id = current_household_id()). Because
-- both the conflicting row and the merged row are in the caller's own household,
-- that policy is satisfied — find-or-create works for an authenticated member.
-- Verified by supabase/tests/14_slots_natural_key_test.sql.

alter table public.slots
  add constraint slots_week_day_meal_key
  unique (week_id, day_of_week, meal_type);
