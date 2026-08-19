-- Guard: no public table may hand `anon`/`authenticated` anything beyond the
-- four privileges the app actually uses, now or ever (issue #140).
--
-- This is the real fix. `20260819140000_default_privileges_hardening.sql`
-- cleans up today's leak and stops the source; this file is what stops it
-- coming back, by turning "remember to revoke on every new table" into "CI
-- fails". 21_table_grants_test.sql names three privileges on three
-- representative tables; that shape is exactly what let `MAINTAIN` through
-- unnoticed on 13 of 15 tables, so this one names NO privileges and NO tables.
--
-- Two deliberate choices:
--
--   * **Allowlist, not denylist.** Asserting "TRUNCATE is absent" only ever
--     tests the privileges someone thought of. Asserting "nothing outside
--     SELECT/INSERT/UPDATE/DELETE is present" covers every privilege
--     PostgreSQL has, including ones added in a future major version — which is
--     precisely how MAINTAIN arrived.
--
--   * **`aclexplode(pg_class.relacl)`, not `information_schema`.** The
--     information_schema views are SQL-standard and do not report `MAINTAIN`
--     at all. A guard built on them passes while the leak is wide open. (The
--     issue suggested iterating information_schema; it would have been blind.)
--
-- The assertions compare against an empty STRING rather than a count, so a
-- failure prints exactly which table and privilege regressed instead of
-- "expected 0, got 3".
--
-- Self-contained: grants are role/table metadata, not row data, so no fixtures.
begin;
select plan(4);

-- 1: nothing outside the allowlist, for either role, on any public table.
select is(
  (select coalesce(string_agg(
            format('%s.%s:%s', a.grantee::regrole::text, c.relname, a.privilege_type),
            ', ' order by c.relname, a.grantee::regrole::text, a.privilege_type), '')
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     cross join lateral aclexplode(c.relacl) a
    where n.nspname = 'public'
      and c.relkind = 'r'
      and a.grantee::regrole::text in ('anon', 'authenticated')
      and a.privilege_type not in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')),
  '',
  'no public table grants anon/authenticated anything beyond SELECT/INSERT/UPDATE/DELETE'
);

-- 2: the default privileges themselves are clean, so the NEXT table created
-- starts safe. Without this the guard above only proves someone remembered to
-- revoke — which is the habit this issue exists to remove.
select is(
  (select coalesce(string_agg(
            format('%s:%s', a.grantee::regrole::text, a.privilege_type),
            ', ' order by a.grantee::regrole::text, a.privilege_type), '')
     from pg_default_acl d
     join pg_namespace n on n.oid = d.defaclnamespace
     cross join lateral aclexplode(d.defaclacl) a
    where n.nspname = 'public'
      and d.defaclobjtype = 'r'
      and pg_get_userbyid(d.defaclrole) = 'postgres'
      and a.grantee::regrole::text in ('anon', 'authenticated')),
  '',
  'default privileges grant anon/authenticated nothing on new public tables'
);

-- 3: the app's own access survives — this must not become a guard that passes
-- because everything was revoked. `authenticated` still reads every table it
-- is supposed to.
select is(
  (select count(*)::int
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and not has_table_privilege('authenticated', c.oid, 'SELECT')),
  0,
  'authenticated still has SELECT on every public table'
);

-- 4: `anon` is not silently granted read access anywhere. Signed-out callers
-- get nothing; the app has no anon-readable table.
select is(
  (select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and has_table_privilege('anon', c.oid, 'SELECT')),
  '',
  'anon cannot SELECT from any public table'
);

select * from finish();
rollback;
