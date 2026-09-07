-- Export step for the issue #170 backfill (READ-ONLY — writes nothing).
--
-- Dumps every ingredient row the generator needs to recompute name/quantity/unit
-- from `raw_text`, as ONE json value so it can be piped straight into the
-- generator without depending on any particular CLI table format.
--
--   npx supabase db query --linked -f scripts/backfill/export-ingredient-rows.sql
--
-- Copy the returned json array into a file (e.g. /tmp/170-ingredients.json), then:
--
--   node scripts/backfill/generate-ingredient-name-backfill.mjs \
--     --in /tmp/170-ingredients.json --out /tmp/170-backfill.sql
--
-- Review /tmp/170-backfill.sql, then apply it the same way (`db query --linked -f`).
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
