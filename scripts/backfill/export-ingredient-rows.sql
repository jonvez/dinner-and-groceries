-- Export step for the issue #170 backfill (READ-ONLY — writes nothing).
--
-- Dumps every ingredient row the generator needs to recompute name/quantity/unit
-- from `raw_text`, as ONE json value so it can be piped straight into the
-- generator without depending on any particular CLI table format.
--
--   npx supabase db query --linked -f scripts/backfill/export-ingredient-rows.sql
--
-- WHAT COMES BACK: there is no `where` here and the transport bypasses RLS, so
-- this returns EVERY household's ingredient rows. Treat the file as cross-tenant
-- data at rest: keep it out of /tmp (world-readable by default on macOS, never
-- cleaned up), 0600, and delete it when the run is done.
--
--   install -d -m 700 ~/.dng-backfill-170
--   umask 077
--
-- Copy the returned json array into ~/.dng-backfill-170/ingredients.json, then:
--
--   node scripts/backfill/generate-ingredient-name-backfill.mjs \
--     --in ~/.dng-backfill-170/ingredients.json \
--     --out ~/.dng-backfill-170/backfill.sql
--
-- Review backfill.sql, apply it the same way (`db query --linked -f`), then
-- delete BOTH files — the generated .sql carries the same rows:
--
--   rm -rf ~/.dng-backfill-170
select coalesce(
         json_agg(
           json_build_object(
             'id', i.id,
             'raw_text', i.raw_text,
             'name', i.name,
             'quantity', i.quantity,
             'unit', i.unit
           )
           order by i.created_at, i.id
         ),
         '[]'::json
       ) as rows
  from public.ingredients as i;
