#!/usr/bin/env node
/**
 * Extract the family's grocery vocabulary from Things 3 (issue #121, epic #135).
 *
 * Jon kept the household's groceries in a Things project for years. Reading the
 * archive showed what it actually is: 630 rows resolving to ~574 DISTINCT names,
 * with the most-repeated name appearing four times. That is not purchase history
 * in any analytic sense — it is a **vocabulary of what this family buys**, which
 * is why the import target is `catalog_items` (suggestions) and not
 * `grocery_items` (this week's list, whose `week_id` is NOT NULL and would have
 * to be faked).
 *
 * ## Reading the database safely
 *
 * Things is a running app with an open WAL. Two rules follow:
 *
 *   1. **Never open the live database.** We copy first and query the copy, so a
 *      long-running read can never take a lock on the app's own file.
 *   2. **Copy the WAL and SHM sidecars too.** `main.sqlite` alone is the state as
 *      of the last checkpoint; anything committed since lives in `main.sqlite-wal`.
 *      Copying only the main file silently loses the most recent items — exactly
 *      the ones most likely to matter.
 *
 * No new dependency: this shells out to the `sqlite3` binary macOS already ships
 * rather than pulling a native SQLite package into the project.
 *
 * ## What counts as an item
 *
 * `TMTask` rows in the Groceries project with `type=0` (a task, not a project or
 * heading) and `trashed=0`. Separator rows — Jon's hand-made `______` dividers —
 * are dropped: they are UNLABELED, they never recorded which section they
 * delimited, and the surviving groupings do not decode. They encode an activity
 * (sorting at shop time), not data, and that activity is what the sections
 * feature replaces.
 *
 * Usage:
 *   node scripts/extract-things-groceries.mjs [--out <file.json>] [--db <path>]
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** The Things "Groceries" project. Stable per-install; verified before use. */
const GROCERIES_PROJECT_UUID = "VauwcqcR5yggTVDtuW83PY";

const THINGS_GROUP_CONTAINER = join(
  homedir(),
  "Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac",
);

/** The main file plus the sidecars that hold everything since the last checkpoint. */
const DB_PARTS = ["main.sqlite", "main.sqlite-wal", "main.sqlite-shm"];

function parseArgs(argv) {
  const args = { out: null, db: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--db") args.db = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

/** `.../ThingsData-XXXXX/Things Database.thingsdatabase/main.sqlite` */
function findThingsDatabase() {
  if (!existsSync(THINGS_GROUP_CONTAINER)) {
    throw new Error(
      `Things group container not found at ${THINGS_GROUP_CONTAINER} — is Things 3 installed?`,
    );
  }
  const dataDirs = readdirSync(THINGS_GROUP_CONTAINER).filter((name) =>
    name.startsWith("ThingsData-"),
  );
  if (dataDirs.length === 0) throw new Error("No ThingsData-* directory found.");
  if (dataDirs.length > 1) {
    // Ambiguity here would mean silently reading the wrong account's data.
    throw new Error(
      `Multiple ThingsData-* directories (${dataDirs.join(", ")}) — pass --db explicitly.`,
    );
  }
  const path = join(
    THINGS_GROUP_CONTAINER,
    dataDirs[0],
    "Things Database.thingsdatabase",
    "main.sqlite",
  );
  if (!existsSync(path)) throw new Error(`Expected a database at ${path}`);
  return path;
}

/**
 * Copy the database and its sidecars somewhere private, and return the copy.
 * Every read below runs against this, never against the file Things has open.
 */
function snapshotDatabase(livePath) {
  const dir = mkdtempSync(join(tmpdir(), "things-extract-"));
  const liveDir = livePath.slice(0, livePath.lastIndexOf("/"));
  for (const part of DB_PARTS) {
    const source = join(liveDir, part);
    if (existsSync(source)) copyFileSync(source, join(dir, part));
  }
  return join(dir, "main.sqlite");
}

function query(dbPath, sql) {
  const out = execFileSync("sqlite3", ["-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.trim() === "" ? [] : JSON.parse(out);
}

/**
 * Things stores dates as Unix epoch seconds (floating point). A row that was
 * never completed has no `stopDate`, which is a legitimate "still on the list"
 * rather than missing data.
 */
function toIsoDate(epochSeconds) {
  if (epochSeconds === null || epochSeconds === undefined) return null;
  return new Date(epochSeconds * 1000).toISOString();
}

/** Collapse whitespace and trim. Case is preserved — see below. */
function normalizeName(title) {
  return title.replace(/\s+/g, " ").trim();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const livePath = args.db ?? findThingsDatabase();
  const dbPath = snapshotDatabase(livePath);

  const project = query(
    dbPath,
    `select uuid, title from TMTask where uuid = '${GROCERIES_PROJECT_UUID}' and type = 1`,
  );
  if (project.length !== 1) {
    throw new Error(
      `Groceries project ${GROCERIES_PROJECT_UUID} not found — has the project been recreated?`,
    );
  }

  // `type = 0` is a task (1 = project, 2 = heading). Separators are dropped by
  // the underscore test; everything else in the project is a real grocery item,
  // completed or not.
  const rows = query(
    dbPath,
    `select title, status, stopDate, creationDate
       from TMTask
      where project = '${GROCERIES_PROJECT_UUID}'
        and type = 0
        and trashed = 0
      order by creationDate asc`,
  );

  const separators = [];
  const items = [];
  for (const row of rows) {
    const title = String(row.title ?? "");
    if (title.replace(/_/g, "").trim() === "") {
      separators.push(title);
      continue;
    }
    const name = normalizeName(title);
    if (name === "") continue;
    items.push({ ...row, name });
  }

  /**
   * Fold to distinct names the same way the destination's uniqueness works:
   * `catalog_items` has `unique (household_id, lower(name))`, so the key here is
   * `lower(trim(name))` and nothing else. The spelling we KEEP is the earliest
   * one the family used — rows are ordered by creation above — matching
   * `promoteToCatalog`, which keeps the first spelling because that is the one
   * they will recognize in a list of chips.
   */
  const byKey = new Map();
  for (const item of items) {
    const key = item.name.toLowerCase();
    const existing = byKey.get(key);
    if (existing) {
      existing.timesBought += 1;
      const stopped = toIsoDate(item.stopDate);
      if (stopped && (!existing.lastBought || stopped > existing.lastBought)) {
        existing.lastBought = stopped;
      }
      if (item.status === 0) existing.stillOnTheList = true;
      continue;
    }
    byKey.set(key, {
      name: item.name,
      timesBought: 1,
      lastBought: toIsoDate(item.stopDate),
      stillOnTheList: item.status === 0,
    });
  }

  // Most-bought first, then alphabetical — a stable order, so re-running this
  // produces a byte-identical file when Things has not changed.
  const names = [...byKey.values()].sort(
    (a, b) => b.timesBought - a.timesBought || a.name.localeCompare(b.name),
  );

  const payload = {
    source: {
      project: project[0].title,
      projectUuid: GROCERIES_PROJECT_UUID,
      // The path, not the contents — this file is committed nowhere by default.
      database: livePath,
    },
    counts: {
      rowsInProject: rows.length,
      separatorsDropped: separators.length,
      items: items.length,
      distinctNames: names.length,
    },
    names,
  };

  const outPath = args.out ?? join(process.cwd(), "things-groceries.json");
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);

  const repeated = names.filter((n) => n.timesBought > 1).length;
  console.log(`Read      ${rows.length} rows from "${project[0].title}"`);
  console.log(`Dropped   ${separators.length} separator rows`);
  console.log(`Kept      ${items.length} items -> ${names.length} distinct names`);
  console.log(`Repeated  ${repeated} names bought more than once`);
  console.log(`Wrote     ${outPath}`);
}

main();
