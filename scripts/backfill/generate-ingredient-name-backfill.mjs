#!/usr/bin/env node
/**
 * Generate the issue #170 backfill SQL: recompute `ingredients.name` /
 * `quantity` / `unit` from the verbatim `raw_text` the ingest path always keeps.
 *
 * This script NEVER talks to a database. It reads an export, runs the REAL
 * parser (`lib/recipes/ingredient.ts` — no fork, no plpgsql re-implementation),
 * and writes a transactional SQL file for a human to read before anything
 * touches prod. Applying it is a separate, deliberate step.
 *
 * ## Run it (three steps)
 *
 *   1. Export (read-only):
 *        npx supabase db query --linked -f scripts/backfill/export-ingredient-rows.sql
 *      Save the returned json array to a file, e.g. /tmp/170-ingredients.json.
 *
 *   2. Generate + REVIEW:
 *        node scripts/backfill/generate-ingredient-name-backfill.mjs \
 *          --in /tmp/170-ingredients.json --out /tmp/170-backfill.sql
 *        less /tmp/170-backfill.sql     # every row it would rewrite is listed
 *
 *   3. Apply (only after the parser fix is merged AND deployed):
 *        npx supabase db query --linked -f /tmp/170-backfill.sql
 *
 * Requires Node with TypeScript type-stripping (>= 22.18 / >= 23.6; older 22.x:
 * add `--experimental-strip-types`), because it imports the app's parser
 * directly rather than copying its rules.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { parseIngredient } from "../../lib/recipes/ingredient.ts";
import {
  planBackfill,
  readExportedRows,
  renderBackfillSql,
} from "./ingredient-name-backfill.ts";

function parseArgs(argv) {
  const args = { in: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--in") args.in = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.in) {
    process.stdout.write(
      "usage: node scripts/backfill/generate-ingredient-name-backfill.mjs --in <export.json> [--out <file.sql>]\n",
    );
    process.exit(args.help ? 0 : 1);
  }

  const rows = readExportedRows(JSON.parse(readFileSync(args.in, "utf8")));
  const plan = planBackfill(rows, parseIngredient);
  const sql = renderBackfillSql(plan);

  if (args.out) writeFileSync(args.out, sql);
  else process.stdout.write(sql);

  process.stderr.write(
    `#170 backfill: ${plan.total} row(s) read — ${plan.updates.length} to repair, ` +
      `${plan.skipped.unchanged} already correct, ` +
      `${plan.skipped.missingRawText} skipped (no usable raw_text).\n` +
      "Nothing has been written to any database. Review the SQL, then apply it with\n" +
      "  npx supabase db query --linked -f <file>\n",
  );
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
