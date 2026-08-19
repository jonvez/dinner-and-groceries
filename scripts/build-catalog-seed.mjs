#!/usr/bin/env node
/**
 * Turn the reviewed Google Sheet into the committed SQL seed (issue #121).
 *
 * The Sheet is the working surface; **this SQL is the artifact of record** — it
 * is what gets reviewed in a PR and what actually touches prod.
 *
 * ## Two inputs, on purpose
 *
 * `Final section` comes from the reviewed Sheet, because that column is Jon's
 * decision and nothing else may override it. Everything ELSE — the exact name,
 * the purchase count, the last-bought timestamp — comes from the original
 * extract, never from the Sheet. Google Sheets silently reformats what looks
 * like a date and coerces what looks like a number, so round-tripping those
 * columns through a spreadsheet would quietly corrupt them. The Sheet is asked
 * only for the judgement it was built to collect.
 *
 * The two are joined by name, and BOTH directions must account for every row:
 * a name in one and not the other means the Sheet drifted from the extract, and
 * silently importing the intersection would drop staples without saying so.
 *
 * Usage:
 *   node scripts/build-catalog-seed.mjs \
 *     --extract <things-groceries.json> \
 *     --reviewed <reviewed.tsv> \
 *     --out supabase/seeds/0001_things_catalog.sql
 */

import { readFileSync, writeFileSync } from "node:fs";

/** Must match the seeded set in `20260817180000_grocery_sections_schema.sql`. */
const SECTIONS = [
  "Produce",
  "Meat & Seafood",
  "Dairy & Eggs",
  "Bakery",
  "Frozen",
  "Pantry",
  "Beverages",
  "Snacks",
  "Household",
  "Pharmacy",
  "Unsorted",
];

/** Review-only: junk that should not become a staple at all. */
const DROP = "Drop";

function parseArgs(argv) {
  const args = { extract: null, reviewed: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--extract") args.extract = argv[++i];
    else if (argv[i] === "--reviewed") args.reviewed = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  for (const required of ["extract", "reviewed", "out"]) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }
  return args;
}

/** Single-quote escaping for a SQL string literal. Names contain apostrophes. */
function sql(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function parseReviewed(path) {
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
  const header = lines[0].split("\t").map((h) => h.trim());
  const nameCol = header.indexOf("Name");
  const finalCol = header.indexOf("Final section");
  if (nameCol === -1 || finalCol === -1) {
    throw new Error(`${path}: expected "Name" and "Final section" columns, got: ${header.join(", ")}`);
  }

  const byKey = new Map();
  const problems = [];
  lines.slice(1).forEach((line, index) => {
    const cells = line.split("\t");
    const name = (cells[nameCol] ?? "").trim();
    const section = (cells[finalCol] ?? "").trim();
    const row = index + 2;

    if (name === "") {
      problems.push(`${path}:${row}: blank name`);
      return;
    }
    // The Sheet has no enforced dropdown, so this is the real gate: a typo'd
    // section would otherwise resolve to nothing and quietly file the item in
    // Unsorted, which reads exactly like a correct import.
    if (section !== DROP && !SECTIONS.includes(section)) {
      problems.push(`${path}:${row}: "${name}" has unknown section ${JSON.stringify(section)}`);
      return;
    }
    const key = name.toLowerCase();
    if (byKey.has(key)) {
      problems.push(`${path}:${row}: duplicate row for "${name}"`);
      return;
    }
    byKey.set(key, section);
  });

  return { byKey, problems };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const extract = JSON.parse(readFileSync(args.extract, "utf8"));
  const { byKey, problems } = parseReviewed(args.reviewed);

  const rows = [];
  const dropped = [];
  const seen = new Set();

  for (const item of extract.names) {
    const key = item.name.toLowerCase();
    const section = byKey.get(key);
    if (section === undefined) {
      problems.push(`extracted name has no reviewed row: ${JSON.stringify(item.name)}`);
      continue;
    }
    seen.add(key);
    if (section === DROP) {
      dropped.push(item.name);
      continue;
    }
    rows.push({
      name: item.name,
      section,
      timesBought: item.timesBought,
      lastBought: item.lastBought,
    });
  }

  for (const key of byKey.keys()) {
    if (!seen.has(key)) problems.push(`reviewed row is not in the extract: ${JSON.stringify(key)}`);
  }

  if (problems.length > 0) {
    console.error("Refusing to build the seed:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  rows.sort((a, b) => a.name.localeCompare(b.name));
  const sectionsUsed = [...new Set(rows.map((r) => r.section))].sort();

  const values = rows
    .map(
      (r) =>
        `    (${sql(r.name)}, ${sql(r.section)}, ${r.timesBought}, ` +
        `${r.lastBought ? `${sql(r.lastBought)}::timestamptz` : "null"})`,
    )
    .join(",\n");

  const out = `-- Seed: the family's grocery vocabulary, imported from Things 3 (issue #121).
--
-- GENERATED — do not edit by hand. Rebuild with:
--   node scripts/extract-things-groceries.mjs --out <extract.json>
--   node scripts/build-catalog-seed.mjs --extract <extract.json> \\
--     --reviewed <reviewed.tsv> --out ${args.out}
--
-- ${rows.length} staples${dropped.length > 0 ? `, ${dropped.length} dropped in review` : ""}, each with the
-- aisle Jon confirmed in the review sheet. These are SUGGESTIONS (catalog_items),
-- not this week's list: the archive resolved to ~574 distinct names with almost
-- no repetition, so it is a vocabulary of what this family buys, not purchase
-- history. Importing it into grocery_items would have meant inventing weeks.
--
-- Applied MANUALLY, like every schema change here — this file lives outside
-- supabase/migrations and outside supabase/seed.sql precisely so that neither
-- \`db reset\` nor a deploy can run it by surprise:
--   psql "$DATABASE_URL" -f ${args.out}
--
-- Idempotent: re-running produces the same state, never doubled counts. Run it
-- twice before trusting it against prod.

begin;

-- Resolve the household by SUBQUERY, never a hardcoded id: a pasted uuid from
-- the wrong environment would import 500 staples into someone else's kitchen.
-- The MVP invariant is one household; if that ever stops being true this must
-- be told WHICH one rather than guessing.
do $$
declare
  v_count integer;
begin
  select count(*) into v_count from public.households;
  if v_count <> 1 then
    raise exception
      'expected exactly one household, found % — pass the target household explicitly before importing',
      v_count;
  end if;
end $$;

-- Every aisle named below must already exist for that household. Without this
-- a typo'd section would resolve to NULL and file the item in Unsorted, which
-- is indistinguishable from a correct import until someone goes shopping.
do $$
declare
  v_missing text;
begin
  select string_agg(s.name, ', ')
    into v_missing
    from (values
${sectionsUsed.map((s) => `      (${sql(s)})`).join(",\n")}
    ) as s(name)
   where not exists (
     select 1 from public.grocery_sections g where lower(g.name) = lower(s.name)
   );
  if v_missing is not null then
    raise exception 'these sections do not exist: %', v_missing;
  end if;
end $$;

insert into public.catalog_items (household_id, name, section_id, added_count, last_added_at)
select
  h.id,
  v.name,
  g.id,
  v.times_bought,
  v.last_bought
from (select id from public.households) as h
cross join (values
${values}
) as v(name, section_name, times_bought, last_bought)
left join public.grocery_sections g
  on g.household_id = h.id
 and lower(g.name) = lower(v.section_name)
on conflict (household_id, lower(name)) do update set
  -- The reviewed sheet is authoritative on the aisle — that is the whole point
  -- of the review — but never blanks one that is already set.
  section_id    = coalesce(excluded.section_id, public.catalog_items.section_id),
  -- greatest(), not +=, so a second run cannot inflate the history. This
  -- mirrors promoteToCatalog's intent (a staple's count only ever grows)
  -- while staying idempotent, which an accumulating bump would not be.
  added_count   = greatest(public.catalog_items.added_count, excluded.added_count),
  last_added_at = greatest(
                    coalesce(public.catalog_items.last_added_at, excluded.last_added_at),
                    coalesce(excluded.last_added_at, public.catalog_items.last_added_at)
                  );

commit;
`;

  writeFileSync(args.out, out);

  const bySection = new Map();
  for (const row of rows) bySection.set(row.section, (bySection.get(row.section) ?? 0) + 1);

  console.error(`Staples   ${rows.length}`);
  console.error(`Dropped   ${dropped.length}${dropped.length ? `: ${dropped.join(", ")}` : ""}`);
  console.error(
    `Sections  ${[...bySection.entries()].sort((a, b) => b[1] - a[1]).map(([s, c]) => `${s} ${c}`).join(", ")}`,
  );
  console.error(`Wrote     ${args.out}`);
}

main();
