# Next.js 16 Upgrade — Implementation Plan (#127)

**Goal:** Upgrade `next` 15.5.23 → 16.3.0 so `npm audit` reaches **0 vulnerabilities**, closing the
residual Next-16-only advisories (and #19's vendored-postcss advisory), without regressing the app.

**Architecture:** Dependency + convention upgrade only. No feature work. The risk is not the code
change (which is tiny) but the **bundler switch**: Next 16 makes **Turbopack the default** for
`next build`, and our Tailwind v4 setup has known open issues under Turbopack. The plan therefore
front-loads a build/visual/E2E verification and keeps `--webpack` as a documented fallback.

**Tech stack:** Next 16.3.0, React 19.2.7 (unchanged — Next 16 peer is `^19.0.0`), Node 22
(unchanged — Next 16 floor is `>=20.9.0`), Tailwind v4, Playwright, Vitest.

## Global constraints

- Node stays **22** (`.nvmrc`, CI, all 3 Dockerfile stages, digest-pinned) — Next 16 floor is 20.9.0,
  already satisfied. **Do not bump Node.**
- React stays **19.2.7** — Next 16 does NOT require React 20.
- Exact version pins (no caret ranges), matching repo style.
- All four required checks must be green; the **Production build (Docker)** check is the real gate
  for the standalone/Turbopack risk.
- `npm audit` must reach **0 vulnerabilities**.

## Change surface (verified against this repo, not assumed)

| Next 16 breaking change | Applies here? | Action |
|---|---|---|
| Sync Request APIs removed (`cookies()`, `params`…) | **No** — already fully awaited/Promise-typed | none |
| **Turbopack default for `build`/`dev`** | **Yes** | verify build + styles + E2E; `--webpack` fallback |
| **`middleware.ts` → `proxy.ts` rename** | **Yes** — repo has `middleware.ts` | rename file + export |
| `next/image` changes (7 separate items) | **No** — `next/image` is NOT used (plain `<img>` by deliberate SSRF-avoidance choice) | none |
| `revalidateTag` 2nd arg; `unstable_cache*`; `unstable_rootParams` | **No** — zero usages | none |
| PPR / `dynamicIO` / `useCache` / `cacheComponents` | **No** — config is only `output: "standalone"` | none |
| Parallel-route `default.tsx` requirement | **No** — no `@slot` folders | none |
| `opengraph-image`/`icon`/`sitemap` async params | **No** — no such files | none |
| `next lint` removed / flat ESLint config | **Partial** — already `eslint .`; bump `eslint-config-next` | bump to 16.3.0 |
| `serverRuntimeConfig`/`publicRuntimeConfig` removed | **No** — uses `NEXT_PUBLIC_*` | none |
| `scroll-behavior` override removed | **No** — no smooth-scroll CSS | none |
| `serverExternalPackages` standalone regression (16.1.x) | **No** — not configured; still verify standalone boots | verify only |

## Tasks

### Task 1: Upgrade the dependencies and rename the middleware convention

**Files:**
- Modify: `package.json` (`next` → `16.3.0`, `eslint-config-next` → `16.3.0`)
- Modify: `package-lock.json` (regenerated)
- Rename: `middleware.ts` → `proxy.ts` (export `middleware` → `proxy`; keep `config.matcher` as-is)

**Interfaces:**
- Consumes: `updateSession` from `lib/supabase/middleware.ts` — **unchanged**, keep the import.
- Produces: a `proxy.ts` at repo root exporting `export async function proxy(request: NextRequest)`
  and the same `export const config = { matcher: [...] }`.

- [ ] **Step 1: Upgrade via the official codemod**

```bash
npx @next/codemod@canary upgrade latest
```
This bumps `next` and migrates the deprecated `middleware` → `proxy` convention. If it does not
perform the rename, do it by hand:
```bash
git mv middleware.ts proxy.ts
# then edit: export async function middleware(  ->  export async function proxy(
```
Keep the file's existing doc comment, updating the first line to say "Next.js proxy entry".

- [ ] **Step 2: Pin the versions exactly**

Ensure `package.json` has exact pins (the codemod may write a caret range):
```json
"next": "16.3.0",
"eslint-config-next": "16.3.0"
```
Then `npm install` to refresh `package-lock.json`.

- [ ] **Step 3: Verify the audit is clean**

```bash
npm audit
```
Expected: `found 0 vulnerabilities`. Paste the exact output in the report. If anything remains,
STOP and report — do NOT run `npm audit fix --force`.

- [ ] **Step 4: Lint, typecheck, unit tests**

```bash
npm run lint && npm run typecheck && npm test
```
Expected: all clean; 521 unit tests pass. If `eslint.config.mjs`'s `FlatCompat` wrapper breaks under
eslint-config-next 16, fix it minimally (native flat import) and say so in the report.

- [ ] **Step 5: Production build under Turbopack (THE risk step)**

```bash
npm run build
```
Expected: succeeds. Then verify Tailwind styles actually emitted (the known Turbopack+Tailwind v4
regression): confirm the built CSS is non-trivial and contains real utility rules, e.g.
```bash
find .next -name "*.css" -size +1k | head
```
If the build fails or CSS is missing/empty, **STOP and report BLOCKED** with the exact error — do not
silently add `--webpack` (that is a posture decision for the human).

- [ ] **Step 6: Standalone boot check**

```bash
npm run start:standalone
```
Expected: server boots and serves. (Guards the 16.1.x standalone regression.) Curl the root, confirm
a 200/redirect rather than a crash, then stop the server. Report what you observed.

- [ ] **Step 7: E2E against the real build**

```bash
npm run test:e2e
```
Expected: the Playwright smoke suite passes — this exercises the renamed `proxy.ts` auth path
(session refresh + route gating), which is the functional risk of the rename.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json proxy.ts
git commit
```
Commit message:
```
chore(deps): upgrade Next.js 15.5.23 -> 16.3.0, migrate middleware -> proxy (#127)

Clears the residual Next-16-only audit advisories (npm audit -> 0), including
the vendored-postcss advisory tracked in #19. Turbopack is now the default
bundler; build, standalone boot, and E2E verified.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

## Verification / acceptance

- `npm audit` = **0 vulnerabilities**
- lint + typecheck + 521 unit tests pass
- `next build` succeeds **under Turbopack** with Tailwind CSS correctly emitted
- `npm run start:standalone` boots
- Playwright E2E passes (proves the `proxy.ts` auth rename works)
- All four required CI checks green, incl. **Production build (Docker)**
- Closes #127 and #19

## Rollback / fallback

If Turbopack proves incompatible with our Tailwind v4 setup, the fallback is to pin the build to
webpack (`next build --webpack`) — but that is a **human decision**, escalated, not taken silently:
it trades the upgrade's clean audit against running a non-default bundler.
