import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseMethod } from "./method-parse";

/**
 * Keeps supabase/tests/26_backfill_parity_test.sql honest from the TypeScript
 * side (#272). That pgTAP file runs the migration's SQL parser over embedded
 * copies of the method fixtures and compares the rows to embedded `expected`
 * JSON. This test proves each embedded copy IS the fixture file and each
 * `expected` IS what parseMethod returns, so pgTAP passing means the SQL
 * backfill and parseMethod agree.
 */

const ROOT = path.resolve(__dirname, "../..");
const PARITY_SQL = readFileSync(
  path.join(ROOT, "supabase/tests/26_backfill_parity_test.sql"),
  "utf8",
);

function dollarBlock(tag: string): string {
  const match = PARITY_SQL.match(new RegExp(`\\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$`));
  if (!match) throw new Error(`no $${tag}$ block in 26_backfill_parity_test.sql`);
  return match[1];
}

const FIXTURES = [
  ["soup", "cilantro-lime-soup.md"],
  ["rigatoni", "no-boil-baked-rigatoni.md"],
  ["edge", "edge-cases.md"],
] as const;

describe.each(FIXTURES)("backfill parity fixture %s", (key, file) => {
  const fixture = readFileSync(path.join(__dirname, "fixtures/methods", file), "utf8");

  it("embeds the fixture text verbatim", () => {
    expect(dollarBlock(`${key}_method`)).toBe(fixture);
  });

  it("expects exactly what parseMethod returns", () => {
    expect(JSON.parse(dollarBlock(`${key}_expected`))).toEqual(toParityShape(parseMethod(fixture)));
  });
});

function toParityShape(phases: ReturnType<typeof parseMethod>) {
  return phases.map((p) => ({
    title: p.title,
    intro: p.intro,
    steps: p.steps.map((s) => ({ body: s.body, notes: s.notes })),
  }));
}

// Interior carriage returns: Postgres `.` matches \r, so the SQL backfill keeps
// "1. a\rb" as a step; parseMethod must too. A raw CR can't live safely in a
// fixture file or a dollar block, so the block spells it `\r` and BOTH sides
// expand it (the pgTAP file with replace(method, '\r', E'\r')).
describe("backfill parity fixture cr (interior carriage returns)", () => {
  it("expects exactly what parseMethod returns", () => {
    const method = dollarBlock("cr_method").replaceAll("\\r", "\r");
    expect(method).toContain("\r");
    expect(JSON.parse(dollarBlock("cr_expected"))).toEqual(toParityShape(parseMethod(method)));
  });
});
