import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * PR-time guard against the out-of-order migration merge (ADR 0015 § Follow-ups).
 *
 * `supabase db push` refuses — exit 1, correctly — to apply a migration file
 * whose timestamp precedes the last version already recorded in prod's history
 * table ("Found local migration files to be inserted before the last migration
 * on remote database"). On a two-developer team that is the single most likely
 * way to red the `migrate` job: two branches each add a migration, the one with
 * the *older* timestamp merges *second*, and the next push to `main` wedges the
 * pipeline for every subsequent deploy until a human renames the file.
 *
 * Nothing about that is detectable from either branch in isolation — it only
 * exists in the merge. But it IS detectable at PR time, against the merge base,
 * with no credentials and no database: every migration this branch adds must
 * sort after every migration that already existed on the base. That is exactly
 * what `db push` will demand later, checked where it is still cheap to fix.
 *
 * Fixing a failure: rename the new file to a timestamp later than the newest one
 * on the base branch (safe — it has only ever been applied to local/CI
 * databases), then `npx supabase db reset --local`. Never renumber a migration
 * that has already reached prod.
 */
const repoRoot = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = "supabase/migrations";

function git(...args: string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], { encoding: "utf8" }).trim();
}

function lines(out: string): string[] {
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

/**
 * The ref this branch will merge into. `GITHUB_BASE_REF` is set on
 * `pull_request` events; on a push to `main` it is empty and `origin/main`
 * resolves to the branch itself, which correctly yields "nothing added".
 */
function resolveBaseRef(): string | null {
  const named = process.env.GITHUB_BASE_REF?.trim();
  const candidates = named
    ? [`origin/${named}`, named, "origin/main", "main"]
    : ["origin/main", "main"];
  for (const ref of candidates) {
    try {
      git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
      return ref;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

describe("migrations added on this branch sort after every pre-existing one", () => {
  it("has no migration file that would be inserted before the base branch's newest", () => {
    if (!existsSync(join(repoRoot, ".git"))) {
      // Not a git checkout (e.g. a packaged tree) — nothing to compare against.
      return;
    }

    const baseRef = resolveBaseRef();
    if (!baseRef) {
      // In CI this must never happen: the `verify` job checks out full history
      // precisely so this comparison is possible. Failing closed here is the
      // point — a silently skipped check is how out-of-order merges get through.
      expect(
        process.env.CI,
        "could not resolve a base ref (need `fetch-depth: 0` on the checkout)",
      ).toBeFalsy();
      return;
    }

    const mergeBase = git("merge-base", baseRef, "HEAD");

    // `--no-renames` on purpose: renaming a migration to a later timestamp is
    // the documented fix for this failure, so the renamed file must be judged
    // as an addition under its NEW name rather than excused as a rename.
    const added = lines(
      git(
        "diff",
        "--name-only",
        "--diff-filter=A",
        "--no-renames",
        mergeBase,
        "HEAD",
        "--",
        MIGRATIONS_DIR,
      ),
    ).filter((p) => p.endsWith(".sql"));

    if (added.length === 0) return;

    const preExisting = lines(
      git("ls-tree", "-r", "--name-only", mergeBase, "--", MIGRATIONS_DIR),
    ).filter((p) => p.endsWith(".sql") && !added.includes(p));

    if (preExisting.length === 0) return;

    // Migration file names are `<14-digit timestamp>_<slug>.sql`, so plain
    // lexical order on the basename is the same order the CLI applies them in.
    const newestOnBase = preExisting.map((p) => basename(p)).sort().at(-1)!;
    const offenders = added
      .map((p) => basename(p))
      .filter((name) => name <= newestOnBase)
      .sort();

    expect(
      offenders,
      `these new migrations sort at or before \`${newestOnBase}\`, which already exists on ` +
        `${baseRef}. \`supabase db push\` will refuse them once ${newestOnBase} is in prod's ` +
        `history. Rename them to a later timestamp and re-run \`npx supabase db reset --local\`.`,
    ).toEqual([]);
  });
});
