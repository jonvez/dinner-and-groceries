/**
 * One-shot backfill for issue #170: recompute `ingredients.name` / `quantity` /
 * `unit` from the verbatim line that was always kept in `raw_text`.
 *
 * Rows saved before the parser fix carry the quantity and unit INSIDE the name
 * ("- 2 cups all-purpose flour"). That name is the roll-up's dedupe key (ADR
 * 0003), so those rows keep defeating the merge long after the parser is fixed —
 * repairing them is the point of this script.
 *
 * ## Shape (and why it is a GENERATOR, not a direct write)
 *
 * This module is pure: rows in, a plan and a SQL file out. The parse function is
 * INJECTED, so the parsing rules are never forked into this script or into
 * plpgsql — a fork is exactly how a "fix" like #170 comes back. The artifact of
 * record is the generated SQL: a human reads the exact UPDATEs before anything
 * touches prod (same pattern as scripts/build-catalog-seed.mjs), and prod is
 * written through the sanctioned transport (`supabase db query --linked -f`).
 *
 * Constraints from the issue, enforced twice — when planning, and again in the
 * emitted SQL so the file is safe on its own:
 *   - never touch a row whose `raw_text` is null/empty;
 *   - never blank a `name` (NOT NULL + non-empty check) — same fallback the
 *     ingest path uses: an empty parse falls back to the raw line;
 *   - never rewrite a row somebody edited between the export and the run.
 *
 * The runnable CLI is `scripts/backfill/generate-ingredient-name-backfill.mjs`.
 */

/** One exported `ingredients` row. `numeric` arrives as a string in JSON. */
export type IngredientExportRow = {
  id: string;
  raw_text: string | null;
  name: string;
  quantity: number | string | null;
  unit: string | null;
};

/** The parser's contract — injected, never imported, so there is one parser. */
export type ParseFn = (raw: string) => {
  quantity: number | null;
  unit: string | null;
  name: string;
  rawText: string;
};

export type BackfillUpdate = {
  id: string;
  /** The name as exported — the optimistic-concurrency guard in the SQL. */
  prevName: string;
  name: string;
  quantity: number | null;
  unit: string | null;
};

export type BackfillPlan = {
  /** Rows read from the export. */
  total: number;
  updates: BackfillUpdate[];
  skipped: {
    /** No verbatim line to recompute from — untouchable, by the issue's rule. */
    missingRawText: number;
    /** Already what the fixed parser produces. */
    unchanged: number;
  };
};

/**
 * Pull the ingredient rows out of whatever the export handed over: a bare json
 * array, or one of the `{ rows: [...] }` / `[{ rows: [...] }]` / `{ data: [...] }`
 * wrappers a `select … as rows` produces. An unrecognized payload THROWS — the
 * alternative is a backfill that silently repairs nothing and reads as a success.
 */
export function readExportedRows(payload: unknown): IngredientExportRow[] {
  const candidate = unwrapRows(payload);
  if (candidate === null) {
    throw new Error(
      "could not find the ingredient rows in this export — expected a json array of " +
        "{id, raw_text, name, quantity, unit}",
    );
  }
  return candidate.map((row, index) => {
    const record = (row ?? {}) as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id === "") {
      throw new Error(`export row ${index} has no id — refusing to generate SQL from it`);
    }
    if (typeof record.name !== "string") {
      throw new Error(`export row ${index} has no name — refusing to generate SQL from it`);
    }
    return {
      id: record.id,
      raw_text: typeof record.raw_text === "string" ? record.raw_text : null,
      name: record.name,
      quantity:
        typeof record.quantity === "number" || typeof record.quantity === "string"
          ? record.quantity
          : null,
      unit: typeof record.unit === "string" ? record.unit : null,
    };
  });
}

/**
 * The array inside a recognized wrapper, or null when there isn't one.
 *
 * Wrappers NEST. `supabase db query --linked` — the command the runbook tells
 * you to run in step 1 — returns `{boundary, rows: [{rows: [...]}]}`, i.e. the
 * ingredient rows two levels down, not the bare array the docs once promised.
 * So unwrap repeatedly until the array we are holding looks like ingredient
 * rows (or we run out of wrappers), rather than assuming a fixed depth. Bounded,
 * so a self-referential or pathological payload cannot spin.
 */
function unwrapRows(payload: unknown): unknown[] | null {
  let current: unknown = payload;

  for (let depth = 0; depth < 8; depth += 1) {
    if (Array.isArray(current)) {
      // A single wrapper object holding exactly one array is another layer, not
      // the rows themselves. An `id` means we have arrived.
      if (current.length === 1 && isRecord(current[0]) && !("id" in current[0])) {
        const nested = Object.values(current[0]).filter(Array.isArray);
        if (nested.length === 1) {
          current = nested[0];
          continue;
        }
      }
      return current;
    }

    if (isRecord(current)) {
      const record = current;
      const next = ["rows", "data", "result"]
        .map((key) => record[key])
        .find(Array.isArray);
      if (next === undefined) return null;
      current = next;
      continue;
    }

    return null;
  }

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Postgres `numeric` may be a string; compare on value, not representation. */
function sameQuantity(stored: number | string | null, parsed: number | null): boolean {
  if (stored === null || stored === undefined) return parsed === null;
  if (parsed === null) return false;
  const asNumber = typeof stored === "number" ? stored : Number(stored);
  return Number.isFinite(asNumber) && asNumber === parsed;
}

/**
 * Plan the repair: what each row's `name`/`quantity`/`unit` SHOULD be once
 * `raw_text` is re-parsed, keeping only the rows that actually differ.
 */
export function planBackfill(rows: IngredientExportRow[], parse: ParseFn): BackfillPlan {
  const updates: BackfillUpdate[] = [];
  let missingRawText = 0;
  let unchanged = 0;

  for (const row of rows) {
    const raw = row.raw_text;
    if (raw === null || raw.trim() === "") {
      missingRawText += 1;
      continue;
    }

    const parsed = parse(raw.trim());
    // Identical fallback to `ingredientRowsFromText` — the name column is NOT
    // NULL with a non-empty check, so an empty parse keeps the raw line.
    const name = parsed.name.trim() === "" ? parsed.rawText.trim() : parsed.name;
    if (name === "") {
      missingRawText += 1;
      continue;
    }

    if (
      name === row.name &&
      sameQuantity(row.quantity, parsed.quantity) &&
      (row.unit ?? null) === parsed.unit
    ) {
      unchanged += 1;
      continue;
    }

    updates.push({
      id: row.id,
      prevName: row.name,
      name,
      quantity: parsed.quantity,
      unit: parsed.unit,
    });
  }

  return { total: rows.length, updates, skipped: { missingRawText, unchanged } };
}

/** A single-quoted SQL literal, or `null`. Quotes are doubled; NULs are refused. */
export function sqlLiteral(value: string | number | null): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`refusing to emit a non-finite number: ${value}`);
    return String(value);
  }
  if (value.includes("\u0000")) {
    throw new Error("refusing to emit a value containing a NUL byte");
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Make a value safe to sit inside a `--` line comment. A newline would end the
 * comment and land the remainder as EXECUTABLE SQL — and in the header that is
 * before `begin;`, outside the transaction, where the rollback guards below
 * cannot reach it. Every other interpolation in the emitted file goes through
 * `sqlLiteral`; this is the encoder for the one that cannot.
 */
export function sqlComment(value: string): string {
  // \n and \r end a Postgres line comment, and a NUL truncates the query on the
  // wire; nothing else inside a comment can reach a statement boundary.
  return value.replace(/[\r\n\u0000]+/g, " ");
}

export type RenderOptions = { generatedAt?: string };

/**
 * Render the plan as ONE reviewable, transactional SQL file. Every guard from
 * the issue is repeated in the statement itself, so the file is safe even if it
 * is applied later, by hand, against a table that moved on underneath it.
 */
export function renderBackfillSql(plan: BackfillPlan, options: RenderOptions = {}): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const header = [
    "-- Backfill for issue #170: recompute ingredients.name/quantity/unit from raw_text.",
    "--",
    "-- GENERATED FILE — do not hand-edit. Regenerate with:",
    "--   node scripts/backfill/generate-ingredient-name-backfill.mjs --in <export.json> --out <this file>",
    `-- Generated at: ${sqlComment(generatedAt)}`,
    `-- Export: ${plan.total} row(s) read — ${plan.updates.length} to repair, ` +
      `${plan.skipped.unchanged} already correct, ` +
      `${plan.skipped.missingRawText} skipped (no usable raw_text).`,
    "--",
    "-- Apply (review the UPDATE list first):",
    "--   npx supabase db query --linked -f <this file>",
    "--",
    "-- Guards: one transaction; never touches a row with a null/empty raw_text;",
    "-- never writes a blank name; never overwrites a row whose name changed since",
    "-- the export; and cannot touch more rows than planned — both sides of the",
    "-- join are uuid primary keys, so it is 1:1 and the abort below is spare.",
    "--",
    "-- The last statement RETURNS the planned/repaired/skipped counts as a result",
    "-- set. Read them: `raise notice` may not survive the transport, and a run that",
    "-- skipped every row is otherwise indistinguishable from a successful one.",
    "",
  ].join("\n");

  if (plan.updates.length === 0) {
    return [
      header,
      "do $$",
      "begin",
      "  raise notice '#170 backfill: nothing to repair — every exported row already matches the parser.';",
      "end",
      "$$;",
      "",
      "select 0 as planned, 0 as repaired, 0 as skipped;",
      "",
    ].join("\n");
  }

  const values = plan.updates
    .map(
      (u) =>
        `  (${sqlLiteral(u.id)}, ${sqlLiteral(u.prevName)}, ${sqlLiteral(u.name)}, ` +
        `${sqlLiteral(u.quantity)}, ${sqlLiteral(u.unit)})`,
    )
    .join(",\n");

  return [
    header,
    "begin;",
    "",
    "create temporary table backfill_170 (",
    "  id        uuid primary key,",
    "  prev_name text not null,",
    "  name      text not null,",
    "  quantity  numeric,",
    "  unit      text",
    ") on commit drop;",
    "",
    "insert into backfill_170 (id, prev_name, name, quantity, unit) values",
    `${values};`,
    "",
    "-- The run's own report. A plpgsql block cannot return a result set, so the",
    "-- counts are parked here and selected below — see the note in the header about",
    "-- not relying on `raise notice` alone.",
    "create temporary table backfill_170_result (",
    "  planned  int not null,",
    "  repaired int not null,",
    "  skipped  int not null",
    ") on commit drop;",
    "",
    "do $$",
    "declare",
    "  planned int := (select count(*) from backfill_170);",
    "  repaired int;",
    "begin",
    "  update public.ingredients as i",
    "     set name = b.name,",
    "         quantity = b.quantity,",
    "         unit = b.unit",
    "    from backfill_170 as b",
    "   where i.id = b.id",
    "     and i.raw_text is not null",
    "     and btrim(i.raw_text) <> ''",
    "     and btrim(b.name) <> ''",
    "     and i.name = b.prev_name;",
    "  get diagnostics repaired = row_count;",
    "  insert into backfill_170_result (planned, repaired, skipped)",
    "    values (planned, repaired, planned - repaired);",
    "  raise notice '#170 backfill: % of % planned row(s) repaired', repaired, planned;",
    "  -- Kept, but DEAD as written: backfill_170.id and public.ingredients.id are",
    "  -- both uuid primary keys, so this UPDATE ... FROM is strictly 1:1 and",
    "  -- `repaired <= planned` is guaranteed by those primary keys, not by this",
    "  -- check. Do not read it as live coverage — it only becomes live again if the",
    "  -- temp table's primary key is ever relaxed.",
    "  if repaired > planned then",
    "    raise exception '#170 backfill touched % row(s), more than the % planned — rolling back',",
    "      repaired, planned;",
    "  end if;",
    "end",
    "$$;",
    "",
    "-- `skipped` = planned rows the guards declined to touch (raw_text emptied, or",
    "-- the name changed between export and run). A healthy run reports skipped = 0.",
    "select planned, repaired, skipped from backfill_170_result;",
    "",
    "commit;",
    "",
  ].join("\n");
}
