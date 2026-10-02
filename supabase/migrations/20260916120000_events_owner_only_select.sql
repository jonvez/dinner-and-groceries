-- Migration: events_owner_only_select (issue #17, ADR 0014)
--
-- The PO dashboard's boundary. `events_select` shipped with #16 as
-- `using (household_id = public.current_household_id())` — HOUSEHOLD-scoped, so
-- every member of the household (the teens included) could read every event row
-- straight through the Data API. #17 adds a `/dashboard` route that 404s for a
-- non-owner, but a route check over a readable table is a curtain over an open
-- door. The gate belongs here.
--
-- After this migration the table is deliberately ASYMMETRIC:
--   * SELECT  — OWNER-only: `household_id = public.current_household_id()
--               and public.is_household_owner()`.
--   * INSERT  — unchanged, household-scoped: EVERY member still emits events
--               (the eight #210 call sites keep working for everyone).
-- Every member emits; only the owner reads. That is the north star's "this
-- exists for me alone, never a kid-facing scorecard", enforced in the database.
--
-- Both helpers are the EXISTING 1a `SECURITY DEFINER` chokepoints from
-- `20260622210412_identity_schema.sql` (`current_household_id()`,
-- `is_household_owner()` — the latter already gates invite create/delete and
-- member removal). NO new helper is introduced (ADR 0003, ADR 0014 §3).
--
-- Append-only is UNCHANGED: there is still no UPDATE/DELETE policy and no
-- UPDATE/DELETE grant, and FORCE RLS stays on, so the owner's new read access
-- does not imply the ability to edit history. Proven in
-- `supabase/tests/15_events_rls_test.sql` (owner allowed; same-household
-- non-owner denied; other-household owner denied; non-owner INSERT still
-- allowed; UPDATE/DELETE/TRUNCATE denied for member AND owner).
--
-- ---------------------------------------------------------------------------
-- EXPAND-ONLY EXCEPTION (ADR 0015 §3) — read this before copying the pattern.
-- ---------------------------------------------------------------------------
-- The repo rule is that a migration merged to `main` must be backward
-- compatible with the app currently deployed, because migrations now apply
-- BEFORE the new container rolls out. This migration TIGHTENS a policy, which
-- the rule normally forbids: if the live app read `events` as a plain member,
-- this would break it between the apply and the deploy.
--
-- It is safe here for one specific, verifiable reason: NOTHING DEPLOYED READS
-- `events`. The only production code touching the table is the eight
-- `emitEvent` INSERT call sites (#210), and INSERT is untouched. The first
-- reader is `/dashboard`, which ships in this same PR — new code, new policy,
-- no window where either half meets the other's assumptions (ADR 0014
-- § Consequences; ADR 0015 §3 calls #17 out by name).
--
-- Any FUTURE member-facing view over `events` has to revisit ADR 0014 — and
-- any other narrowing change still needs the two-PR dance (stop depending on
-- it, deploy, then contract).
--
-- ---------------------------------------------------------------------------
-- TIMESTAMP: 20260916120000 sorts after every migration on `main` (max
-- 20260909120000), after #64's pending 20260915143000, and after the inert
-- smoke migration landing with #68's migrate job — the pipeline's own
-- out-of-order guard exits 1 on a file that sorts before prod's head
-- (ADR 0015 §6), and #68 merges first.
-- ---------------------------------------------------------------------------

-- `drop` + `create` rather than `alter policy`: the full predicate is then
-- visible in one place in this file, which is what a reviewer needs to read.
drop policy events_select on public.events;

create policy events_select on public.events
  for select to authenticated
  using (
    household_id = public.current_household_id()
    and public.is_household_owner()
  );
