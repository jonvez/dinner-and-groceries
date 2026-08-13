-- Migration: revoke_dangerous_table_grants (issue #49)
--
-- Root cause: Supabase's project-wide default privileges (postgres role's
-- pg_default_acl) grant broad table access — effectively ALL, which includes
-- TRUNCATE, REFERENCES, and TRIGGER — to `anon`/`authenticated` on every
-- newly created `public` table. The `events` table already defends against
-- this (20260707161759_events_schema.sql: `revoke all ... then grant back
-- select, insert`), but every other table in this project only ever added
-- `grant select, insert, update, delete` ON TOP OF the default grant, so
-- TRUNCATE/REFERENCES/TRIGGER are still sitting there for `authenticated`
-- (and `anon`, where it holds any grant at all). TRUNCATE in particular
-- bypasses RLS entirely and is a bulk delete — it would let any raw-SQL
-- client wipe a table across every household.
--
-- Severity is LOW: none of these three privileges are reachable via
-- PostgREST/supabase-js (the actual client surface), so this is a
-- defense-in-depth DB-layer hardening, not a fix for a live exploit.
--
-- Scope: grants only. No RLS policy, function, or SELECT/INSERT/UPDATE/DELETE
-- grant is touched — the app depends on those and none of them are affected
-- by this revoke. `members`' column-level
-- `update(display_name, avatar)` grant is untouched (only TRUNCATE/
-- REFERENCES/TRIGGER are revoked here). Re-running this against `events` is
-- a harmless no-op (it already lacks these privileges); included for
-- uniformity across every public table.
--
-- Not in scope (tracked as a follow-up, not fixed here): `alter default
-- privileges` so future tables are created without the leak in the first
-- place. That requires identifying/owning the correct role to alter the
-- default for and is a separate concern from this table-by-table cleanup.
revoke truncate, references, trigger on public.households from anon, authenticated;
revoke truncate, references, trigger on public.members from anon, authenticated;
revoke truncate, references, trigger on public.invites from anon, authenticated;
revoke truncate, references, trigger on public.dishes from anon, authenticated;
revoke truncate, references, trigger on public.weeks from anon, authenticated;
revoke truncate, references, trigger on public.slots from anon, authenticated;
revoke truncate, references, trigger on public.slot_dishes from anon, authenticated;
revoke truncate, references, trigger on public.proposals from anon, authenticated;
revoke truncate, references, trigger on public.reactions from anon, authenticated;
revoke truncate, references, trigger on public.comments from anon, authenticated;
revoke truncate, references, trigger on public.events from anon, authenticated;
revoke truncate, references, trigger on public.ingredients from anon, authenticated;
revoke truncate, references, trigger on public.catalog_items from anon, authenticated;
revoke truncate, references, trigger on public.grocery_items from anon, authenticated;
