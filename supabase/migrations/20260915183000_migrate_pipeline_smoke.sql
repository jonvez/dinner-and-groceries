-- #68 / ADR 0015: proves the automated prod migrate path end-to-end. Changes nothing.
--
-- The `migrate` job needs to be exercised against the real prod database, but
-- waiting for a real schema change to do that means the first thing the pipeline
-- ever applies is also the first thing that can break. So: an inert migration.
-- It creates, alters and drops nothing, needs no privileges beyond connecting,
-- and applies harmlessly to local/CI databases. Its row in
-- `supabase_migrations.schema_migrations` is the evidence the whole path works.
--
-- It stays in the repo permanently — migrations are append-only, and an applied
-- migration is never edited or deleted (the CLI silently ignores edits to files
-- already in the history table, so a changed applied file is invisible drift).
do $$
begin
  raise notice 'migrate pipeline smoke (#68)';
end $$;
