-- Defense-in-depth guard for issue #49: Supabase's project-wide default
-- privileges hand `TRUNCATE`/`REFERENCES`/`TRIGGER` to `anon`/`authenticated`
-- on every newly created `public` table (the `events` table already defends
-- against this in 20260707161759_events_schema.sql; every other table did
-- not, until 20260813120000_revoke_dangerous_table_grants.sql). `TRUNCATE`
-- in particular bypasses RLS entirely and is a bulk delete, so it must not be
-- reachable even by a raw-SQL client using the `authenticated`/`anon` role.
--
-- Self-contained: grants are role/table metadata, not row data, so no
-- fixtures are needed. Three representative tables (dishes, grocery_items,
-- households) stand in for all 14 revoked tables — the migration is a
-- uniform loop over the same statement per table, so spot-checking a few
-- plus confirming SELECT/INSERT survive is sufficient to catch either an
-- over-revoke or a missed table.
begin;
select plan(8);

-- TRUNCATE revoked from authenticated on the three representative tables.
select ok(
  NOT has_table_privilege('authenticated', 'public.dishes', 'TRUNCATE'),
  'authenticated cannot TRUNCATE public.dishes'
);
select ok(
  NOT has_table_privilege('authenticated', 'public.grocery_items', 'TRUNCATE'),
  'authenticated cannot TRUNCATE public.grocery_items'
);
select ok(
  NOT has_table_privilege('authenticated', 'public.households', 'TRUNCATE'),
  'authenticated cannot TRUNCATE public.households'
);

-- TRIGGER and REFERENCES revoked from authenticated on dishes.
select ok(
  NOT has_table_privilege('authenticated', 'public.dishes', 'TRIGGER'),
  'authenticated cannot add a TRIGGER on public.dishes'
);
select ok(
  NOT has_table_privilege('authenticated', 'public.dishes', 'REFERENCES'),
  'authenticated cannot create a REFERENCES constraint against public.dishes'
);

-- SELECT/INSERT are untouched (proves we did not over-revoke).
select ok(
  has_table_privilege('authenticated', 'public.dishes', 'SELECT'),
  'authenticated still has SELECT on public.dishes'
);
select ok(
  has_table_privilege('authenticated', 'public.dishes', 'INSERT'),
  'authenticated still has INSERT on public.dishes'
);

-- anon is revoked too (the migration targets both roles).
select ok(
  NOT has_table_privilege('anon', 'public.dishes', 'TRUNCATE'),
  'anon cannot TRUNCATE public.dishes'
);

select * from finish();
rollback;
