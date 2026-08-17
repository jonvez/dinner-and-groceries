import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Config-invariant guard for the home-screen icons (#82), in the same spirit as
 * ci-deploy-env-wiring.test.ts.
 *
 * Next's `output: "standalone"` build does NOT include `public/`. The runtime
 * image must copy it explicitly, and nothing in CI can catch its absence: the
 * Docker build still succeeds, the container still boots, every existing E2E
 * test still passes — the icons and manifest simply 404 in production, so the
 * installed app on a phone gets a blank/screenshot icon.
 *
 * The Dockerfile shipped with this COPY commented out ("uncomment once a
 * public/ dir exists"), which is exactly how it would silently regress.
 */
const repoRoot = dirname(fileURLToPath(import.meta.url));
const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
const packageJson = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
);

/** Non-comment Dockerfile lines. */
const activeLines = dockerfile
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"));

describe("static assets in public/ survive the standalone packaging", () => {
  it("the runtime image copies public/ (not left commented out)", () => {
    const copiesPublic = activeLines.some((line) =>
      /COPY\s.*\/app\/public\s+\.\/public/.test(line),
    );
    expect(copiesPublic).toBe(true);
  });

  it("start:standalone copies public/ next to the server", () => {
    // Playwright boots this exact command, so without the copy the E2E asset
    // assertions would fail locally while prod stayed broken for another reason.
    expect(packageJson.scripts["start:standalone"]).toMatch(
      /cp -r public \.next\/standalone\/public/,
    );
  });
});

/**
 * The web app manifest is a Next ROUTE, not a file in public/, so the proxy's
 * matcher decides whether an anonymous request can read it. Safari fetches the
 * manifest during "Add to Home Screen" — if it is gated, a signed-out install
 * silently falls back to a page-screenshot icon and the wrong app name.
 */
describe("the proxy matcher leaves install assets public", () => {
  const proxy = readFileSync(join(repoRoot, "proxy.ts"), "utf8");

  // Rebuild the live matcher and assert on its BEHAVIOUR rather than on the
  // source text, so this tests the auth boundary itself and not its spelling.
  const matcherLine = proxy
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith('"/((?!'));

  if (!matcherLine) {
    throw new Error("could not locate the proxy matcher in proxy.ts");
  }

  const matcher = new RegExp(
    `^${JSON.parse(matcherLine.replace(/,$/, "")) as string}$`,
  );

  /** true = the proxy runs on this path (auth gating applies). */
  const isGated = (path: string) => matcher.test(path);

  it("does not gate the web app manifest", () => {
    // Safari fetches this during "Add to Home Screen", signed out.
    expect(isGated("/manifest.webmanifest")).toBe(false);
  });

  it("does not gate the icons", () => {
    expect(isGated("/apple-touch-icon.png")).toBe(false);
    expect(isGated("/icon-192.png")).toBe(false);
    expect(isGated("/icon.svg")).toBe(false);
  });

  it("still gates the application routes", () => {
    // The exclusion must stay a narrow allowlist, not a blanket opt-out.
    expect(isGated("/")).toBe(true);
    expect(isGated("/board")).toBe(true);
    expect(isGated("/grocery")).toBe(true);
    expect(isGated("/recipes")).toBe(true);
    expect(isGated("/auth/callback")).toBe(true);
  });
});
