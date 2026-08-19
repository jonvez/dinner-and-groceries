#!/usr/bin/env node
/**
 * Join the Things extract to the proposed aisles, and emit the review table
 * (issue #121, epic #135).
 *
 * This is the checkpoint between the offline categorization pass and Jon's
 * reconciliation in a Google Sheet. It exists mostly to FAIL LOUDLY: the
 * proposals are keyed by name, hand-authored, and a mistyped or stale key would
 * otherwise vanish silently and quietly drop a staple from the import. So every
 * name must be accounted for in both directions, and every section must be one
 * the database actually has.
 *
 * Output is TSV on stdout (or `--out`), ready to paste into a Sheet:
 *
 *   Name · Times bought · Last bought · Proposed section · Final section ·
 *   Confidence · Notes
 *
 * `Final section` is the authoritative column and ships pre-filled with the
 * proposal, so reviewing means changing the few that are wrong rather than
 * filling in 574 blanks. Rows are ordered LOWEST CONFIDENCE FIRST: the dozen
 * genuinely ambiguous names read first, the obvious 500 below them.
 *
 * Usage:
 *   node scripts/build-things-review.mjs --extract <things-groceries.json> [--out <file.tsv>]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROPOSALS = join(import.meta.dirname, "data", "things-sections.psv");

/**
 * The sections seeded for every household by
 * `20260817180000_grocery_sections_schema.sql`, in aisle order, plus the review
 * -only `Drop`. A proposal naming anything else is a typo, and a typo that
 * reached the Sheet's dropdown would let Jon "file" items into a section that
 * does not exist.
 */
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

const CONFIDENCE_ORDER = { low: 0, medium: 1, high: 2 };

function parseArgs(argv) {
  const args = { extract: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--extract") args.extract = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!args.extract) throw new Error("--extract <things-groceries.json> is required");
  return args;
}

function loadProposals() {
  const text = readFileSync(PROPOSALS, "utf8");
  const byKey = new Map();
  const problems = [];

  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const lineNumber = index + 1;

    const parts = line.split("|");
    if (parts.length !== 4) {
      problems.push(`${PROPOSALS}:${lineNumber}: expected 4 fields, got ${parts.length}`);
      return;
    }
    const [name, section, confidence, notes] = parts.map((p) => p.trim());

    if (!SECTIONS.includes(section) && section !== DROP) {
      problems.push(`${PROPOSALS}:${lineNumber}: unknown section "${section}" for "${name}"`);
    }
    if (!(confidence in CONFIDENCE_ORDER)) {
      problems.push(`${PROPOSALS}:${lineNumber}: confidence must be low/medium/high, got "${confidence}"`);
    }

    const key = name.toLowerCase();
    if (byKey.has(key)) {
      problems.push(`${PROPOSALS}:${lineNumber}: duplicate entry for "${name}"`);
      return;
    }
    byKey.set(key, { name, section, confidence, notes });
  });

  return { byKey, problems };
}

/** Tabs and newlines would corrupt the TSV; nothing legitimately contains them. */
function cell(value) {
  return String(value ?? "").replace(/[\t\r\n]+/g, " ");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const extract = JSON.parse(readFileSync(args.extract, "utf8"));
  const { byKey, problems } = loadProposals();

  const rows = [];
  const uncategorized = [];
  const matched = new Set();

  for (const item of extract.names) {
    const key = item.name.toLowerCase();
    const proposal = byKey.get(key);
    if (!proposal) {
      uncategorized.push(item.name);
      continue;
    }
    matched.add(key);
    rows.push({
      name: item.name,
      timesBought: item.timesBought,
      lastBought: item.lastBought ? item.lastBought.slice(0, 10) : "",
      section: proposal.section,
      confidence: proposal.confidence,
      notes: proposal.notes,
    });
  }

  // A key here means the proposals drifted from the extract — a rename in
  // Things, or a typo that has been silently proposing nothing.
  const stale = [...byKey.keys()].filter((key) => !matched.has(key));

  if (uncategorized.length > 0) {
    problems.push(
      `${uncategorized.length} extracted name(s) have no proposed section:\n  ` +
        uncategorized.map((n) => JSON.stringify(n)).join("\n  "),
    );
  }
  if (stale.length > 0) {
    problems.push(
      `${stale.length} proposed name(s) are not in the extract:\n  ` +
        stale.map((k) => JSON.stringify(byKey.get(k).name)).join("\n  "),
    );
  }

  if (problems.length > 0) {
    console.error("Refusing to build the review table:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  // Lowest confidence first, then most-bought (a name they buy often is worth
  // more of Jon's attention than a one-off), then alphabetical for stability.
  rows.sort(
    (a, b) =>
      CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence] ||
      b.timesBought - a.timesBought ||
      a.name.localeCompare(b.name),
  );

  const header = [
    "Name",
    "Times bought",
    "Last bought",
    "Proposed section",
    "Final section",
    "Confidence",
    "Notes",
  ];
  const tsv = [
    header.join("\t"),
    ...rows.map((r) =>
      [
        cell(r.name),
        r.timesBought,
        cell(r.lastBought),
        cell(r.section),
        // Pre-filled, and the authoritative column: reviewing means changing
        // the few that are wrong, not filling in 574 blanks.
        cell(r.section),
        cell(r.confidence),
        cell(r.notes),
      ].join("\t"),
    ),
  ].join("\n");

  if (args.out) writeFileSync(args.out, `${tsv}\n`);
  else process.stdout.write(`${tsv}\n`);

  const byConfidence = { low: 0, medium: 0, high: 0 };
  const bySection = new Map();
  for (const row of rows) {
    byConfidence[row.confidence] += 1;
    bySection.set(row.section, (bySection.get(row.section) ?? 0) + 1);
  }
  const summary = [...bySection.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([section, count]) => `${section} ${count}`)
    .join(", ");

  console.error(`Rows        ${rows.length}`);
  console.error(
    `Confidence  low ${byConfidence.low}, medium ${byConfidence.medium}, high ${byConfidence.high}`,
  );
  console.error(`Sections    ${summary}`);
  if (args.out) console.error(`Wrote       ${args.out}`);
}

main();
