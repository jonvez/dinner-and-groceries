import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Regression guard for the prod 500 on the first Cloud Run deploy (2026-07-10).
 *
 * `NEXT_PUBLIC_*` are consumed on TWO paths and BOTH must be wired by the deploy
 * job, or prod breaks in a way NO app-level test can see:
 *   - CLIENT bundle: `next build` inlines *static* `process.env.NEXT_PUBLIC_*`
 *     at BUILD time -> must be Docker `build-args`.
 *   - SERVER (SSR): `lib/supabase/middleware.ts` & `server-component.ts` call
 *     `readSupabaseEnv()` which reads `process.env` *dynamically* (NOT inlined)
 *     -> the running container needs them as Cloud Run RUNTIME `secrets`.
 *
 * Providing only build-args => the middleware throws "Missing required Supabase
 * env var(s)" and every request 500s (the actual incident). Providing only the
 * runtime binding => the browser sign-in client has no config and throws.
 *
 * The E2E smoke can't catch a missing runtime binding: it runs the standalone
 * server with the env present, so it never exercises the prod "build-time only"
 * condition. Hence this config-invariant test.
 */
const ciYml = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), ".github/workflows/ci.yml"),
  "utf8",
);

const VARS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];

describe("deploy job wires NEXT_PUBLIC_* on both the build and runtime paths", () => {
  it.each(VARS)("passes %s to docker build as a build-arg (client bundle)", (v) => {
    // e.g. `NEXT_PUBLIC_SUPABASE_URL=${{ env.NEXT_PUBLIC_SUPABASE_URL }}`
    expect(ciYml).toMatch(
      new RegExp(`build-args:[\\s\\S]*${v}=\\$\\{\\{\\s*env\\.${v}\\s*\\}\\}`),
    );
  });

  it.each(VARS)("binds %s as a Cloud Run runtime secret (SSR path)", (v) => {
    // e.g. `NEXT_PUBLIC_SUPABASE_URL=NEXT_PUBLIC_SUPABASE_URL:latest`
    expect(ciYml).toMatch(new RegExp(`secrets:[\\s\\S]*${v}=${v}:latest`));
  });

  it("never binds or fetches the service-role key on the deploy path", () => {
    expect(ciYml).not.toMatch(/SERVICE_ROLE/i);
  });
});
