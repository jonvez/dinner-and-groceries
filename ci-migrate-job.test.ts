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

/**
 * One job block with whole-line comments removed — the same executable view as
 * `ciYmlExecutable`, scoped to a single job.
 *
 * Every assertion that greps the migrate job's *steps* runs against this rather
 * than the raw text. A config-invariant test that greps a file must grep the
 * executable view of it: the raw block includes explanatory comments, and an
 * assertion a comment can satisfy guards nothing. This bit us for real — the
 * masking-order assertion below passed with the masking line deleted outright,
 * because `::add-mask::` also appears in the comment eight lines above the step.
 */
function jobBlockExecutable(name: string): string {
  return jobBlock(name)
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
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
    expect(jobBlockExecutable("migrate")).toMatch(
      /if:\s*\$\{\{\s*github\.ref\s*==\s*'refs\/heads\/main'\s*&&\s*github\.event_name\s*==\s*'push'\s*\}\}/,
    );
  });

  it("pushes with an explicit --db-url and --yes (no prompt, no link state)", () => {
    const block = jobBlockExecutable("migrate");
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
    // Indices are compared inside the EXECUTABLE view and both are pinned to a
    // whole `echo` line, never to the bare `::add-mask::` token: the step is
    // preceded by a comment that names the token, and matching that comment made
    // this assertion pass even with the masking line deleted.
    const block = jobBlockExecutable("migrate");
    const mask = block.search(/^\s*echo "::add-mask::/m);
    const envWrite = block.search(/^\s*echo "SUPABASE_MIGRATION_DB_URL=\$URI" >> "\$GITHUB_ENV"/m);
    expect(mask, "migrate must ::add-mask:: the fetched URI in an executable step").toBeGreaterThan(
      -1,
    );
    expect(envWrite, "migrate must export the URI via $GITHUB_ENV").toBeGreaterThan(-1);
    expect(mask).toBeLessThan(envWrite);
  });

  it("percent-escapes the URI before masking it", () => {
    // The runner un-escapes %25 -> %, %0A -> LF and %0D -> CR in workflow-command
    // DATA, so `::add-mask::` on a raw URI containing any of them registers a mask
    // string that never matches the real secret — leaving the prod credential
    // unmasked for the whole job. The runbook mandates an alphanumeric password to
    // avoid this, but nothing in the pipeline enforces a human instruction.
    expect(
      jobBlockExecutable("migrate"),
      "migrate must mask `${URI//%/%25}`, not the raw `$URI`",
    ).toMatch(/^\s*echo "::add-mask::\$\{URI\/\/%\/%25\}"$/m);
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
    expect(jobBlockExecutable("migrate")).toMatch(
      /^\s{4}concurrency:\n\s{6}group:\s*prod-migrate\n\s{6}cancel-in-progress:\s*false\n/m,
    );
  });
});
