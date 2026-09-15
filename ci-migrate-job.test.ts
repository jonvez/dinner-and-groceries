import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Config invariants for the `migrate` job that applies DB migrations to cloud
 * prod on every push to `main` (issue #68, ADR 0015).
 *
 * This job is the only thing in the repo that holds a credential able to do
 * DDL/DML on the production database with RLS bypassed, so its *shape* is a
 * security property, not a style preference. Nothing at the app level can see a
 * regression here — hence a config-invariant test, in the same spirit as
 * `ci-deploy-env-wiring.test.ts`.
 *
 * What each assertion protects (ADR 0015 §§ 3, 4, 6, 8):
 *   - ordering: migrate runs after the test gates and BEFORE deploy, so a failed
 *     apply leaves prod on old code AND old schema rather than new code on old
 *     schema (the #63 / `/grocery` failure);
 *   - `--include-all` / `--debug` stay out: the first turns fail-closed drift
 *     into a silent out-of-order apply, the second prints the connection string;
 *   - the URI is masked before it can reach a log and is never bound to Cloud
 *     Run — the running app must never hold an RLS-bypassing credential;
 *   - `main` runs queue instead of cancelling, so no run dies mid-apply.
 */
const repoRoot = dirname(fileURLToPath(import.meta.url));
const ciYml = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");

/**
 * `ci.yml` with whole-line comments removed — YAML comments and, inside `run: |`
 * blocks, shell comments both start with `#`. Banned-flag assertions run against
 * this so a comment may *explain* why a flag is absent while still proving no
 * step actually passes it.
 */
const ciYmlExecutable = ciYml
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

/** The text of one top-level job block: `  <name>:` up to the next `  <name>:` (or EOF). */
function jobBlock(name: string): string {
  const start = ciYml.search(new RegExp(`^  ${name}:$`, "m"));
  expect(start, `ci.yml has no top-level \`${name}:\` job`).toBeGreaterThan(-1);
  const rest = ciYml.slice(start);
  const next = rest.slice(1).search(/^ {2}[\w-]+:$/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** The `needs:` entries of a job, whether written inline or as a block list. */
function jobNeeds(name: string): string[] {
  const block = jobBlock(name);
  const inline = block.match(/^\s{4}needs:\s*\[([^\]]*)\]/m);
  if (inline) return inline[1].split(",").map((s) => s.trim()).filter(Boolean);
  const listed = block.match(/^\s{4}needs:\s*\n((?:\s{6}-\s*\S+\n)+)/m);
  return listed
    ? listed[1].split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean)
    : [];
}

describe("migrate job applies migrations to prod before the app deploys", () => {
  it("declares a migrate job gated on the test tiers, including RLS pgTAP", () => {
    // `rls` is in the needs deliberately: no migration reaches prod on a commit
    // whose pgTAP allow/deny suite did not pass (ADR 0015 § 3).
    expect(jobNeeds("migrate")).toEqual(expect.arrayContaining(["verify", "rls", "e2e"]));
  });

  it("makes deploy depend on migrate, so a failed apply skips the deploy", () => {
    expect(jobNeeds("deploy")).toContain("migrate");
  });

  it("runs migrate only on pushes to main — never on a pull request", () => {
    // A PR (least of all a fork's) must never reach the prod credential.
    expect(jobBlock("migrate")).toMatch(
      /if:\s*\$\{\{\s*github\.ref\s*==\s*'refs\/heads\/main'\s*&&\s*github\.event_name\s*==\s*'push'\s*\}\}/,
    );
  });

  it("pushes with an explicit --db-url and --yes (no prompt, no link state)", () => {
    const block = jobBlock("migrate");
    expect(block).toMatch(/supabase db push[^\n]*--db-url "\$SUPABASE_MIGRATION_DB_URL"/);
    expect(block).toMatch(/supabase db push[^\n]*--yes/);
  });

  it("never passes --include-all or --debug anywhere in the workflow", () => {
    // --include-all would apply an out-of-order migration silently instead of
    // failing closed; --debug prints the connection string into the run log.
    expect(ciYmlExecutable).not.toMatch(/--include-all/);
    expect(ciYmlExecutable).not.toMatch(/--debug/);
  });

  it("masks the connection URI before it is written to $GITHUB_ENV", () => {
    const block = jobBlock("migrate");
    const mask = block.indexOf("::add-mask::");
    const envWrite = block.indexOf('SUPABASE_MIGRATION_DB_URL=$URI" >> "$GITHUB_ENV');
    expect(mask, "migrate must ::add-mask:: the fetched URI").toBeGreaterThan(-1);
    expect(envWrite, "migrate must export the URI via $GITHUB_ENV").toBeGreaterThan(-1);
    expect(mask).toBeLessThan(envWrite);
  });

  it("never binds the migration URI to Cloud Run, and still fetches no service-role key", () => {
    // The running app has no business holding a credential that bypasses RLS
    // (ADR 0003, ADR 0015 § 8).
    const cloudRunSecrets = ciYml.match(/^\s+secrets:\s*\|\n(?:\s{12}\S+\n)+/gm) ?? [];
    expect(cloudRunSecrets.length).toBeGreaterThan(0);
    for (const bindings of cloudRunSecrets) {
      expect(bindings).not.toMatch(/SUPABASE_MIGRATION_DB_URL/);
    }
    expect(jobBlock("deploy")).not.toMatch(/SUPABASE_MIGRATION_DB_URL/);
    expect(ciYml).not.toMatch(/SERVICE_ROLE/i);
  });

  it("does not cancel in-progress runs on main (no run dies mid-apply)", () => {
    const workflowConcurrency = ciYml.match(/^concurrency:\n((?:\s{2}\S[^\n]*\n)+)/m);
    expect(workflowConcurrency, "ci.yml has no workflow-level concurrency block").not.toBeNull();
    expect(workflowConcurrency![1]).toMatch(/cancel-in-progress:/);
    expect(workflowConcurrency![1]).not.toMatch(/cancel-in-progress:\s*true\s*$/m);
  });

  it("serializes prod applies with its own never-cancelling concurrency group", () => {
    expect(jobBlock("migrate")).toMatch(
      /^\s{4}concurrency:\n\s{6}group:\s*prod-migrate\n\s{6}cancel-in-progress:\s*false\n/m,
    );
  });
});
