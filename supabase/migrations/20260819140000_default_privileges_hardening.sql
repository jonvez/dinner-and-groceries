-- Migration: default_privileges_hardening (issue #140)
--
-- Closes the follow-up #49/PR #129 explicitly deferred, and which #136 then hit
-- again within days: Supabase's project-wide default privileges hand extra
-- table privileges to `anon`/`authenticated` on every NEWLY created `public`
-- table, so each new table has to remember to revoke them. Nothing fails when
-- you forget — the app works, the tests pass, the grant just sits there.
--
-- ## Which role's defaults actually apply
--
-- #49 flagged "identifying the correct role" as the part needing thought, so
-- for the record, from `pg_default_acl` on a freshly reset database:
--
--   grantor          | schema | acl
--   -----------------+--------+------------------------------------------
--   postgres         | public | anon=Dxtm/postgres, authenticated=Dxtm/...
--   supabase_admin   | public | anon=arwdDxtm/supabase_admin, ...
--
-- Default privileges are keyed on the role that CREATES the object. Migrations
-- run as `postgres` and every table in `public` is owned by `postgres`, so the
-- `postgres` row is the one in force. The `supabase_admin` row would only apply
-- to tables that role creates, and `pg_has_role('postgres','supabase_admin',
-- 'MEMBER')` is false — we could not alter it even if we wanted to, and it is
-- Supabase's to manage. Hence `for role postgres`, stated explicitly rather
-- than relying on the current role at apply time.
--
-- ## Why `revoke all` and not a list of privilege names
--
-- Because the list is exactly what rotted. #49 revoked `truncate, references,
-- trigger` from all 14 tables then in existence. PostgreSQL 17 later added
-- `MAINTAIN` (VACUUM / ANALYZE / CLUSTER / REINDEX / REFRESH, and the
-- ACCESS EXCLUSIVE locks they take), the default ACL grants it, and an audit
-- while writing this migration found it sitting on **13 of 15** public tables
-- for both `anon` and `authenticated`.
--
-- The two clean tables were `events` and `grocery_sections` — the only two that
-- ever used `revoke all ... then grant back`. That is the whole argument: a
-- named list silently stops covering the privileges a later PostgreSQL invents,
-- and an allowlist does not. `revoke all` is also version-portable, which
-- matters because naming `maintain` outright would fail on any PG below 17.
--
-- Revoking ALL from the default costs nothing here: the default only ever
-- granted `Dxtm`, never `arwd`. Every SELECT/INSERT/UPDATE/DELETE this app
-- relies on comes from an explicit `grant` in the table's own migration and is
-- untouched. From here on a new table starts with NOTHING for these roles, so
-- forgetting the grant fails loudly (permission denied) instead of silently
-- over-permitting — the direction you want the mistake to point.
--
-- ## Not in scope
--
-- `service_role` keeps its inherited privileges. It holds TRUNCATE/REFERENCES/
-- TRIGGER/MAINTAIN on all 15 tables and SELECT on none, which is incoherent but
-- inert here: ADR 0003 forbids a service-role key on any app path, so nothing
-- in this system authenticates as it. It is a Supabase-managed role and
-- revoking from it risks breaking platform tooling in ways nothing here would
-- notice. Deliberately left alone rather than tidied.
--
-- There are no sequences in `public` (every PK is a uuid), so the sequence
-- default ACL is moot and is left as Supabase ships it.

-- ---------------------------------------------------------------------------
-- 1. Future tables: stop the leak at the source
-- ---------------------------------------------------------------------------
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Existing tables: revoke whatever leaked, whatever it happens to be
-- ---------------------------------------------------------------------------
-- Data-driven on purpose. Rather than name the privileges to remove (the
-- mistake above), read what these roles actually hold and remove anything
-- outside the allowlist the app needs. That makes this correct on any server
-- version without a `server_version_num` branch, and correct for privileges
-- that do not exist yet.
--
-- `aclexplode(relacl)`, not `information_schema.role_table_grants`: the
-- information_schema view is SQL-standard and does NOT report `MAINTAIN` — an
-- audit built on it reports "all clean" while every table leaks. Verified
-- directly; it is the reason this migration exists at all.
--
-- Only TABLE-level grants are touched. Column-level grants live in
-- `pg_attribute.attacl` and are not returned here, so `members`' deliberate
-- `update(display_name, avatar)` column grant survives untouched.
do $$
declare
  r record;
begin
  for r in
    select
      c.oid::regclass          as table_ref,
      a.grantee::regrole::text as role_name,
      a.privilege_type
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) a
    where n.nspname = 'public'
      and c.relkind = 'r'
      and a.grantee::regrole::text in ('anon', 'authenticated')
      and a.privilege_type not in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  loop
    -- privilege_type comes from pg_catalog, never from user input.
    execute format(
      'revoke %s on table %s from %I',
      r.privilege_type, r.table_ref, r.role_name
    );
    raise notice 'revoked % on % from %', r.privilege_type, r.table_ref, r.role_name;
  end loop;
end $$;
