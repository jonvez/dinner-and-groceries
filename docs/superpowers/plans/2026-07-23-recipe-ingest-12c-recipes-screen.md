# 12c — Recipes screen + ingest server action Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/recipes/new` screen where a signed-in member pastes a recipe URL (or skips straight to a by-hand editor), reviews/edits an extracted preview, and saves it as a `dishes` + `ingredients` library entry — the integration brick that wires 12z's route, 12a's extractor, #76's SSRF-guarded fetcher, #11's ingredient parser, and 12b's table into the real feature.

**Architecture:** Two pure orchestration functions in `app/recipes/new/ingest-core.ts` — `fetchRecipePreview` (injected fetcher → `extractRecipeJsonLd` → scrub URLs → editable preview, no DB) and `saveIngestedDish` (injected Supabase-like client → best-effort `dishes` insert + `ingredients` insert) — are unit-tested without a network call or a live DB, exactly mirroring `app/board/actions-core.ts`. A thin `"use server"` `actions.ts` supplies the real `safeFetchHtml` + cookie-session client and resolves identity from the verified session via a local `actor.ts` (mirrors `app/board/actor.ts`). A client component (`recipe-ingest-form.tsx`) drives two `useActionState` forms — fetch-preview and save — rendered by `page.tsx`. `/recipes` (12z's shell) gets an "Add a recipe" link wired to the new route so the feature is reachable.

**Tech Stack:** Next.js 15 App Router (React 19 Server Actions), TypeScript, Supabase (`@supabase/supabase-js`, RLS in force), Vitest + Testing Library (jsdom), Playwright (authed E2E project).

## Kickoff Resolutions (2026-08-04) — these OVERRIDE any conflicting text below

Decisions made at the recipe-epic kickoff, after this plan was drafted. Where one conflicts with a task below, **the resolution wins** — adjust the affected task to match.

1. **Presentation: full page** (`/recipes/new`), not a modal. (Already assumed below; recorded for completeness.)

2. **Post-save = Post/Redirect/Get to the saved recipe.** `saveIngestedDish` MUST return the newly-created dish's `id`. On a successful dish insert the Server Action MUST `redirect(\`/recipes/${id}\`)` (`redirect` from `next/navigation`). Do NOT leave the user on `/recipes/new` with a populated form. Rationale: staying on `/recipes/new` lets the back button + a second submit create duplicate dishes — PRG to a canonical resource URL removes that entire edge-case class. This **supersedes** any "clear the form / inline success / stay on page" handling in Task 5 and the corresponding open-question note at the end of the plan. (Keep the `revalidate('/recipes')` — it still refreshes the library behind the redirect.)

3. **NEW scope — a minimal read-only recipe detail page** `app/recipes/[id]/page.tsx` is part of 12c; it is the redirect target from resolution 2. Requirements: protected route; fetch the dish + its ingredients by `id` through the cookie-session client (**RLS scopes to the caller's household — an id belonging to another household must return nothing**); render title, image URL/`<img>`, prep/cook/total minutes, and the ingredient lines as text. On no row found (bad id OR another household's recipe) render a friendly not-found state (`notFound()` / 404-ish copy), never a crash. Give it its own TDD task with coverage for the found AND not-found/cross-household paths. This page is also the target 12d's library list will link to.

4. **"Add another" affordance is DEFERRED** → backlogged as **issue #88**. Do not build a post-save "add another" shortcut in 12c.

5. **Ingredient editing stays raw-text, one line per line** (textarea) — confirmed.

6. **Title-only + by-hand entry must work (no URL required).** A member can save a recipe with just a title and ZERO ingredients — the save path must NOT require a URL, an extraction, or any ingredient row. Manually-typed ingredient lines are first-class: the by-hand flow (leave the URL field empty, type a title, optionally type ingredient lines in the textarea, Save) produces a `dishes` row + its `ingredients` rows exactly like the URL flow. Add explicit test coverage for (a) title-only save → one dish, zero ingredients, and (b) title + hand-typed ingredient lines, no URL → dish + ingredient rows.

7. **Video / non-recipe URLs are out of scope and handled gracefully.** A URL with no `schema.org/Recipe` JSON-LD (a YouTube/video page, an arbitrary article) yields a null extraction → the user lands in the editable by-hand form with a friendly "we couldn't read a recipe from that — add it by hand" notice. It must NEVER crash or persist a garbage recipe. Explicit video-host detection/messaging is NOT built here.

8. **Editing an already-saved recipe is OUT of scope** (the `/recipes/{id}` detail page is read-only) → backlogged. The by-hand ACs above are satisfied at CREATION time in the add form.

## Global Constraints

- **No service-role key anywhere.** Every write runs as the signed-in user through the cookie-session client (`createServerComponentClient`); RLS + `public.current_household_id()` do the household scoping.
- **Identity/household come from the VERIFIED session only** — never from form input. Every Server Action independently re-resolves the actor (does not rely on the middleware alone), matching `app/board/actor.ts`'s stated posture.
- **The URL fetch MUST go through `safeFetchHtml`** (`lib/http/safe-fetch.ts`, #76) — this feature never opens its own socket or calls a bare `fetch()` on user input.
- **Every URL that could be persisted or rendered — `source_url` AND `image_url` — MUST pass through `safeHttpUrl`** (`lib/web/safe-url.ts`) before it is stored. An unsafe scheme (`javascript:`, `data:`, etc.) is DROPPED (stored/shown as `null`), never merely warned about, and never blocks an otherwise-valid save.
- **The route segment pins `export const runtime = "nodejs"`** — `safeFetchHtml` uses `node:http`/`node:https`/`node:dns`/`node:net`, unavailable on Edge.
- **Untrusted text is rendered as text only** — no `dangerouslySetInnerHTML` anywhere in this feature; ingredient lines and the title go through plain React children / controlled inputs, which escape by construction.
- **Persistence is best-effort, non-atomic** (accepted precedent, `proposeNewDish`): the dish insert and the ingredients insert are two statements; a dish-saved/ingredients-failed outcome is benign and surfaced as a soft notice, not an error.
- **Command hygiene:** explicit `git add <path>` (never `-A`), no `cd`-compounded git commands, real non-interactive flags.
- **Conventional commits** (`feat:`, `test:`, `chore:`) with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` on every commit.
- **PRs only, human merges** — matches this repo's actual workflow for 12a/12b/12z (branch-protected, reviewed PRs). Do not push directly to `main`.

## File Structure

- `app/recipes/new/ingest-core.ts` — **create.** Pure orchestration, no framework glue: `fetchRecipePreview` (fetch → extract → scrub, injected fetcher) and `saveIngestedDish` (dish + ingredients insert, injected DB client, best-effort). No React, no `"use server"`.
- `app/recipes/new/ingest-core.test.ts` — **create.** Unit tests for both functions over fakes (no network, no DB).
- `app/recipes/new/actor.ts` — **create.** `resolveRecipeActor` — household + member id from the verified session. Mirrors `app/board/actor.ts`'s `resolveActor` minus the week concept this flow doesn't have.
- `app/recipes/new/actor.test.ts` — **create.**
- `app/recipes/new/actions.ts` — **create.** The thin `"use server"` boundary: builds the real client, resolves the actor, calls `ingest-core.ts` with the real `safeFetchHtml`, emits the `recipe_ingested` analytics event on a URL-sourced save, revalidates `/recipes`, and on a successful save **redirects to `/recipes/{id}` (PRG — kickoff resolution 2)**.
- `app/recipes/new/recipe-ingest-form.tsx` — **create.** Client component: the fetch-preview form + the edit/save form (title, image URL, prep/cook/total minutes, one-ingredient-per-line textarea).
- `app/recipes/new/recipe-ingest-form.test.tsx` — **create.** Component tests with `./actions` mocked (matches `app/board/propose-form.test.tsx`'s pattern).
- `app/recipes/new/page.tsx` — **create.** The protected route (`runtime = "nodejs"`, `dynamic = "force-dynamic"`); renders `<AppNav/>` + the form.
- `app/recipes/new/page.test.tsx` — **create.**
- `app/recipes/[id]/detail-core.ts` — **create (kickoff resolution 3).** Pure `loadRecipeDetail(supabase, id)` — RLS-scoped dish + ingredient-line fetch over an injected client, returns the detail view or `null` (no row = bad id OR another household's recipe). No React, no `"use server"`; unit-tested like `ingest-core.ts`.
- `app/recipes/[id]/detail-core.test.ts` — **create.** Found + not-found/cross-household paths over a fake client.
- `app/recipes/[id]/page.tsx` — **create (kickoff resolution 3).** The read-only recipe detail page and the PRG redirect target from Task 4. Async Server Component (`dynamic = "force-dynamic"`) mirroring `app/board/page.tsx`: resolve `params.id`, build the cookie-session client, call `loadRecipeDetail`, `notFound()` on `null`, else render title/image/times/ingredient lines as text. No unit test (async RSC + live client — matches the repo's `app/board/page.tsx` precedent, which has none; the found path is covered by Task 9's E2E round-trip and the not-found branch by `detail-core.test.ts`).
- `app/recipes/page.tsx` — **modify.** Replace the 12z placeholder copy with a real "Add a recipe" link to `/recipes/new` (otherwise this brick ships with no way to reach it).
- `app/recipes/page.test.tsx` — **modify.** Add an assertion for the new link.
- `e2e/authed/recipes.spec.ts` — **create.** Authenticated E2E: the by-hand add flow only (rationale for not live-fetching a URL in Task 8).

---

### Task 1: `fetchRecipePreview` — fetch + extract a preview (pure, no DB)

**Files:**
- Create: `app/recipes/new/ingest-core.ts`
- Create: `app/recipes/new/ingest-core.test.ts`

**Interfaces:**
- Consumes: `extractRecipeJsonLd(html): ExtractedRecipe | null` (`@/lib/recipes/recipe-jsonld`), `safeHttpUrl(value): string | null` (`@/lib/web/safe-url`), `type SafeFetchResult` / `type SafeFetchFailure` (`@/lib/http/safe-fetch`).
- Produces: `RecipePreviewFields`, `EMPTY_RECIPE_PREVIEW`, `type FetchHtml = (url: string) => Promise<SafeFetchResult>`, `type FetchPreviewResult`, `fetchRecipePreview(fetchHtml: FetchHtml, rawUrl: string): Promise<FetchPreviewResult>` — consumed by Task 4's `actions.ts` and Task 5's component tests (via the mocked action's return shape).

- [ ] **Step 1: Write the failing tests**

```ts
// app/recipes/new/ingest-core.test.ts
import { describe, expect, it, vi } from "vitest";

import type { SafeFetchFailure, SafeFetchResult } from "@/lib/http/safe-fetch";

import {
  EMPTY_RECIPE_PREVIEW,
  fetchRecipePreview,
  type FetchHtml,
} from "./ingest-core";

/**
 * `fetchRecipePreview` orchestrates the fetch → extract → scrub pipeline over
 * an INJECTED fetcher (no live network) so both the SSRF-guarded fetcher's
 * rejections and JSON-LD extraction/scrubbing are exercised deterministically.
 * See ingest-core.ts's module doc for the security contract this pins.
 */

const RECIPE_JSON = {
  "@context": "https://schema.org",
  "@type": "Recipe",
  name: "Carnitas Tacos",
  image: "https://example.com/tacos.jpg",
  recipeIngredient: ["2 lb pork shoulder", "1 tbsp ground cumin"],
  prepTime: "PT20M",
  cookTime: "PT1H30M",
  totalTime: "PT1H50M",
};
const RECIPE_HTML = `<html><head><script type="application/ld+json">${JSON.stringify(RECIPE_JSON)}</script></head><body></body></html>`;

const XSS_IMAGE_HTML = `<html><head><script type="application/ld+json">${JSON.stringify(
  {
    "@type": "Recipe",
    name: "Sneaky",
    image: "javascript:alert(1)",
    recipeIngredient: ["1 egg"],
  },
)}</script></head></html>`;

const NO_RECIPE_HTML = `<html><body><p>Just a blog post, no recipe here.</p></body></html>`;

function fetchOk(html: string): FetchHtml {
  return vi.fn(
    async (url: string): Promise<SafeFetchResult> => ({ ok: true, html, finalUrl: url }),
  );
}

function fetchFail(reason: SafeFetchFailure): FetchHtml {
  return vi.fn(async (): Promise<SafeFetchResult> => ({ ok: false, reason }));
}

describe("fetchRecipePreview", () => {
  it("returns an editable preview extracted from a fetched recipe page", async () => {
    const fetchHtml = fetchOk(RECIPE_HTML);
    const result = await fetchRecipePreview(fetchHtml, "https://example.com/tacos");

    expect(result).toEqual({
      ok: true,
      sourceUrl: "https://example.com/tacos",
      preview: {
        title: "Carnitas Tacos",
        imageUrl: "https://example.com/tacos.jpg",
        ingredientLines: ["2 lb pork shoulder", "1 tbsp ground cumin"],
        prepMinutes: 20,
        cookMinutes: 90,
        totalMinutes: 110,
      },
    });
    expect(fetchHtml).toHaveBeenCalledWith("https://example.com/tacos");
  });

  it("rejects a non-http(s) URL WITHOUT ever calling the fetcher", async () => {
    const fetchHtml = vi.fn();
    const result = await fetchRecipePreview(
      fetchHtml as unknown as FetchHtml,
      "javascript:alert(1)",
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.notice).toMatch(/valid http/i);
    expect(result.preview).toEqual(EMPTY_RECIPE_PREVIEW);
    expect(fetchHtml).not.toHaveBeenCalled();
  });

  it("falls back to the empty editable preview when the fetch is blocked (SSRF / private range)", async () => {
    const fetchHtml = fetchFail("blocked-address");
    const result = await fetchRecipePreview(fetchHtml, "http://169.254.169.254/");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.notice).toMatch(/couldn't fetch/i);
    expect(result.preview).toEqual(EMPTY_RECIPE_PREVIEW);
  });

  it("falls back to the empty editable preview when the page has no Recipe JSON-LD", async () => {
    const fetchHtml = fetchOk(NO_RECIPE_HTML);
    const result = await fetchRecipePreview(fetchHtml, "https://example.com/blog-post");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.notice).toMatch(/couldn't find a recipe/i);
    expect(result.preview).toEqual(EMPTY_RECIPE_PREVIEW);
  });

  it("drops a javascript: image URL found in the page's JSON-LD (never reaches the client)", async () => {
    const fetchHtml = fetchOk(XSS_IMAGE_HTML);
    const result = await fetchRecipePreview(fetchHtml, "https://example.com/sneaky");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.preview.imageUrl).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/recipes/new/ingest-core.test.ts`
Expected: FAIL — `Cannot find module './ingest-core'` (the file doesn't exist yet).

- [ ] **Step 3: Write the minimal implementation**

```ts
// app/recipes/new/ingest-core.ts
/**
 * Pure orchestration for the recipe-ingest flow (issue #12c, Slice 1c): fetching
 * + extracting a preview from a pasted URL, and (Task 2) persisting the edited
 * result to the library. Like the board's `actions-core.ts`, these take injected
 * collaborators (a fetch function / a Supabase-like client) so they are
 * unit-tested WITHOUT a live network call or a live DB. The thin Server Actions
 * (`actions.ts`) supply the real `safeFetchHtml` + cookie-session client and
 * resolve identity from the verified session.
 *
 * Security (design of record, #12c):
 *   - `fetchRecipePreview` calls ONLY the injected fetcher (production: the
 *     SSRF-guarded `safeFetchHtml`, #76) — this module never opens a socket
 *     itself.
 *   - Every URL that could reach storage — the pasted `sourceUrl` AND the
 *     extracted/edited `imageUrl` — is scrubbed through `safeHttpUrl` before it
 *     is returned to the client OR persisted. An unsafe image URL is DROPPED
 *     (stored/shown as null); the recipe still saves (never a dead end).
 *   - Extraction failure (no JSON-LD Recipe) and fetch failure both fall back to
 *     the SAME empty, editable preview shape — the by-hand editor is never a
 *     distinct code path the UI has to special-case.
 */

import { extractRecipeJsonLd } from "@/lib/recipes/recipe-jsonld";
import { safeHttpUrl } from "@/lib/web/safe-url";
import type { SafeFetchResult } from "@/lib/http/safe-fetch";

// ---------------------------------------------------------------------------
// Fetch + extract a preview (no DB write — Save is a separate, explicit step)
// ---------------------------------------------------------------------------

export type RecipePreviewFields = {
  title: string;
  imageUrl: string | null;
  ingredientLines: string[];
  prepMinutes: number | null;
  cookMinutes: number | null;
  totalMinutes: number | null;
};

/** The shape every code path renders — extraction failure is never a dead end. */
export const EMPTY_RECIPE_PREVIEW: RecipePreviewFields = {
  title: "",
  imageUrl: null,
  ingredientLines: [],
  prepMinutes: null,
  cookMinutes: null,
  totalMinutes: null,
};

export type FetchHtml = (url: string) => Promise<SafeFetchResult>;

export type FetchPreviewResult =
  | { ok: true; sourceUrl: string; preview: RecipePreviewFields }
  | { ok: false; notice: string; preview: RecipePreviewFields };

/**
 * Fetch `rawUrl` through the injected (SSRF-guarded, in production) `fetchHtml`,
 * extract a schema.org/Recipe, and return an editable preview. Never throws:
 * every failure — a bad scheme, a blocked/unreachable/non-HTML fetch, or a page
 * with no Recipe JSON-LD — resolves to `{ ok: false }` carrying the SAME empty,
 * editable preview shape, so the caller always has a form to render.
 */
export async function fetchRecipePreview(
  fetchHtml: FetchHtml,
  rawUrl: string,
): Promise<FetchPreviewResult> {
  const url = safeHttpUrl(rawUrl);
  if (!url) {
    return {
      ok: false,
      notice: "Enter a valid http(s) recipe link, or add it by hand below.",
      preview: EMPTY_RECIPE_PREVIEW,
    };
  }

  const fetched = await fetchHtml(url);
  if (!fetched.ok) {
    return {
      ok: false,
      notice: "We couldn't fetch that page. Check the link, or add the recipe by hand below.",
      preview: EMPTY_RECIPE_PREVIEW,
    };
  }

  const extracted = extractRecipeJsonLd(fetched.html);
  if (!extracted) {
    return {
      ok: false,
      notice: "We couldn't find a recipe on that page. Add it by hand below.",
      preview: EMPTY_RECIPE_PREVIEW,
    };
  }

  return {
    ok: true,
    sourceUrl: url,
    preview: {
      title: extracted.title ?? "",
      // Scrub BEFORE this ever reaches the client — a page's JSON-LD `image` is
      // untrusted content (a `javascript:` URL here would otherwise round-trip
      // straight into the editor's Image URL field).
      imageUrl: safeHttpUrl(extracted.imageUrl),
      ingredientLines: extracted.ingredientLines,
      prepMinutes: extracted.prepMinutes,
      cookMinutes: extracted.cookMinutes,
      totalMinutes: extracted.totalMinutes,
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/recipes/new/ingest-core.test.ts`
Expected: PASS — 5 tests green.

- [ ] **Step 5: Commit**

```bash
git add app/recipes/new/ingest-core.ts app/recipes/new/ingest-core.test.ts
git commit -m "feat(recipes): fetchRecipePreview — fetch + extract + scrub orchestration (#12c)"
```

---

### Task 2: `saveIngestedDish` — persist dish + ingredients (best-effort, non-atomic)

**Files:**
- Modify: `app/recipes/new/ingest-core.ts`
- Modify: `app/recipes/new/ingest-core.test.ts`

**Interfaces:**
- Consumes: `parseIngredient(raw): ParsedIngredient` (`@/lib/recipes/ingredient`), `safeHttpUrl` (already imported), `SupabaseClient<Database>` (`@supabase/supabase-js`, `@/lib/database.types`).
- Produces: `SaveIngestedDishInput`, `SaveIngestedDishResult`, `ingredientRowsFromText(text, householdId, dishId): IngredientInsert[]`, `saveIngestedDish(supabase, input): Promise<SaveIngestedDishResult>` — consumed by Task 4's `actions.ts`.

- [ ] **Step 1: Write the failing tests**

Add this import (replacing Task 1's import line) and append the new `describe` blocks to `app/recipes/new/ingest-core.test.ts`:

```ts
import {
  EMPTY_RECIPE_PREVIEW,
  fetchRecipePreview,
  ingredientRowsFromText,
  saveIngestedDish,
  type FetchHtml,
} from "./ingest-core";
```

```ts
describe("ingredientRowsFromText", () => {
  it("parses each non-blank line, in order, with household/dish scoping", () => {
    const rows = ingredientRowsFromText(
      "2 lb pork shoulder\n\n1 tbsp ground cumin",
      "hh-1",
      "d1",
    );
    expect(rows).toEqual([
      {
        household_id: "hh-1",
        dish_id: "d1",
        name: "pork shoulder",
        quantity: 2,
        unit: "lb",
        raw_text: "2 lb pork shoulder",
        position: 0,
      },
      {
        household_id: "hh-1",
        dish_id: "d1",
        name: "ground cumin",
        quantity: 1,
        unit: "tbsp",
        raw_text: "1 tbsp ground cumin",
        position: 1,
      },
    ]);
  });

  it("falls back to the raw line as the name when parsing yields no name (e.g. a bare quantity)", () => {
    const rows = ingredientRowsFromText("2", "hh-1", "d1");
    expect(rows).toEqual([
      {
        household_id: "hh-1",
        dish_id: "d1",
        name: "2",
        quantity: 2,
        unit: null,
        raw_text: "2",
        position: 0,
      },
    ]);
  });

  it("returns no rows for blank input", () => {
    expect(ingredientRowsFromText("   \n\n  ", "hh-1", "d1")).toEqual([]);
  });
});

type Result = { data: unknown; error: unknown };

function makeSaveClient(opts: { dish?: Result; ingredientsError?: unknown }) {
  const dishesInsert: unknown[] = [];
  const ingredientsInsert: unknown[] = [];
  const fromTables: string[] = [];

  const from = vi.fn((table: string) => {
    fromTables.push(table);
    if (table === "dishes") {
      return {
        insert: vi.fn((vals: unknown) => {
          dishesInsert.push(vals);
          return {
            select: () => ({
              single: async () => opts.dish ?? { data: { id: "d1" }, error: null },
            }),
          };
        }),
      };
    }
    return {
      insert: vi.fn((vals: unknown) => {
        ingredientsInsert.push(vals);
        return Promise.resolve({ error: opts.ingredientsError ?? null });
      }),
    };
  });

  return {
    client: { from } as unknown as Parameters<typeof saveIngestedDish>[0],
    calls: { dishesInsert, ingredientsInsert, fromTables },
  };
}

describe("saveIngestedDish", () => {
  it("inserts the dish then its ingredients, in order", async () => {
    const { client, calls } = makeSaveClient({});

    const result = await saveIngestedDish(client, {
      householdId: "hh-1",
      createdBy: "m1",
      title: "  Carnitas Tacos  ",
      sourceUrl: "https://example.com/tacos",
      imageUrl: "https://example.com/tacos.jpg",
      prepMinutes: "20",
      cookMinutes: "90",
      totalMinutes: "110",
      ingredientsText: "2 lb pork shoulder\n1 tbsp ground cumin",
    });

    expect(result).toEqual({ ok: true, dishId: "d1", ingredientsSaved: true });
    expect(calls.dishesInsert).toEqual([
      {
        household_id: "hh-1",
        title: "Carnitas Tacos",
        source_url: "https://example.com/tacos",
        image_url: "https://example.com/tacos.jpg",
        prep_minutes: 20,
        cook_minutes: 90,
        total_minutes: 110,
        created_by: "m1",
      },
    ]);
    expect(calls.ingredientsInsert).toEqual([
      [
        {
          household_id: "hh-1",
          dish_id: "d1",
          name: "pork shoulder",
          quantity: 2,
          unit: "lb",
          raw_text: "2 lb pork shoulder",
          position: 0,
        },
        {
          household_id: "hh-1",
          dish_id: "d1",
          name: "ground cumin",
          quantity: 1,
          unit: "tbsp",
          raw_text: "1 tbsp ground cumin",
          position: 1,
        },
      ],
    ]);
  });

  it("rejects a blank title before any DB call", async () => {
    const { client, calls } = makeSaveClient({});
    const result = await saveIngestedDish(client, {
      householdId: "hh-1",
      createdBy: "m1",
      title: "   ",
      sourceUrl: "",
      imageUrl: "",
      prepMinutes: "",
      cookMinutes: "",
      totalMinutes: "",
      ingredientsText: "",
    });
    expect(result.ok).toBe(false);
    expect(calls.fromTables).toEqual([]);
  });

  it("stores null source/image URLs and null times for a by-hand add with no URL", async () => {
    const { client, calls } = makeSaveClient({});
    await saveIngestedDish(client, {
      householdId: "hh-1",
      createdBy: "m1",
      title: "Skillet Chicken",
      sourceUrl: "",
      imageUrl: "",
      prepMinutes: "",
      cookMinutes: "",
      totalMinutes: "",
      ingredientsText: "1 lb chicken thighs",
    });
    expect(calls.dishesInsert[0]).toMatchObject({
      source_url: null,
      image_url: null,
      prep_minutes: null,
      cook_minutes: null,
      total_minutes: null,
    });
  });

  it("drops (not blocks on) a javascript: image URL — the dish still saves", async () => {
    const { client, calls } = makeSaveClient({});
    const result = await saveIngestedDish(client, {
      householdId: "hh-1",
      createdBy: "m1",
      title: "Sneaky",
      sourceUrl: "",
      imageUrl: "javascript:alert(document.cookie)",
      prepMinutes: "",
      cookMinutes: "",
      totalMinutes: "",
      ingredientsText: "1 egg",
    });
    expect(result.ok).toBe(true);
    expect(calls.dishesInsert[0]).toMatchObject({ image_url: null });
  });

  it("drops a mistyped/tampered source URL rather than failing the save", async () => {
    const { client, calls } = makeSaveClient({});
    const result = await saveIngestedDish(client, {
      householdId: "hh-1",
      createdBy: "m1",
      title: "Tampered",
      sourceUrl: "javascript:alert(1)",
      imageUrl: "",
      prepMinutes: "",
      cookMinutes: "",
      totalMinutes: "",
      ingredientsText: "",
    });
    expect(result.ok).toBe(true);
    expect(calls.dishesInsert[0]).toMatchObject({ source_url: null });
  });

  it("ignores unparseable/negative minutes fields rather than crashing, and rounds decimals", async () => {
    const { client, calls } = makeSaveClient({});
    await saveIngestedDish(client, {
      householdId: "hh-1",
      createdBy: "m1",
      title: "Weird Times",
      sourceUrl: "",
      imageUrl: "",
      prepMinutes: "not-a-number",
      cookMinutes: "-5",
      totalMinutes: "12.7",
      ingredientsText: "",
    });
    expect(calls.dishesInsert[0]).toMatchObject({
      prep_minutes: null,
      cook_minutes: null,
      total_minutes: 13,
    });
  });

  it("does not touch the ingredients table for a title-only add (no ingredient lines)", async () => {
    const { client, calls } = makeSaveClient({});
    const result = await saveIngestedDish(client, {
      householdId: "hh-1",
      createdBy: "m1",
      title: "Just a title",
      sourceUrl: "",
      imageUrl: "",
      prepMinutes: "",
      cookMinutes: "",
      totalMinutes: "",
      ingredientsText: "   ",
    });
    expect(result).toEqual({ ok: true, dishId: "d1", ingredientsSaved: true });
    expect(calls.fromTables).toEqual(["dishes"]);
  });

  it("returns a benign ingredientsSaved:false when the dish saves but the ingredients insert fails", async () => {
    const { client } = makeSaveClient({ ingredientsError: { message: "boom" } });
    const result = await saveIngestedDish(client, {
      householdId: "hh-1",
      createdBy: "m1",
      title: "Half Saved",
      sourceUrl: "",
      imageUrl: "",
      prepMinutes: "",
      cookMinutes: "",
      totalMinutes: "",
      ingredientsText: "1 egg",
    });
    expect(result).toEqual({ ok: true, dishId: "d1", ingredientsSaved: false });
  });

  it("fails closed when the dish insert itself errors", async () => {
    const { client, calls } = makeSaveClient({
      dish: { data: null, error: { message: "boom" } },
    });
    const result = await saveIngestedDish(client, {
      householdId: "hh-1",
      createdBy: "m1",
      title: "Ill-Fated",
      sourceUrl: "",
      imageUrl: "",
      prepMinutes: "",
      cookMinutes: "",
      totalMinutes: "",
      ingredientsText: "1 egg",
    });
    expect(result.ok).toBe(false);
    expect(calls.ingredientsInsert).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/recipes/new/ingest-core.test.ts`
Expected: FAIL — `ingredientRowsFromText`/`saveIngestedDish` are not exported yet.

- [ ] **Step 3: Write the minimal implementation**

Add these imports to the top of `app/recipes/new/ingest-core.ts` (alongside Task 1's):

```ts
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";
import { parseIngredient } from "@/lib/recipes/ingredient";
```

Append to the bottom of `app/recipes/new/ingest-core.ts`:

```ts
type DbClient = SupabaseClient<Database>;
type IngredientInsert = Database["public"]["Tables"]["ingredients"]["Insert"];

// ---------------------------------------------------------------------------
// Save the edited result to the library (dish + ingredients)
// ---------------------------------------------------------------------------

export type SaveIngestedDishInput = {
  /** From the caller's VERIFIED session — never request input. */
  householdId: string;
  /** From the caller's VERIFIED session — never request input. */
  createdBy: string;
  title: string;
  /** Raw form value. "" means by-hand (no source) — never "ingested" for analytics. */
  sourceUrl: string;
  /** Raw form value (extracted OR hand-typed) — scheme-validated before persist. */
  imageUrl: string;
  /** Raw numeric text from the editor. */
  prepMinutes: string;
  cookMinutes: string;
  totalMinutes: string;
  /** Raw textarea content — one ingredient per line. */
  ingredientsText: string;
};

export type SaveIngestedDishResult =
  | { ok: true; dishId: string; ingredientsSaved: boolean }
  | { ok: false; error: string };

function parseMinutesField(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

/**
 * One ingredient row per non-blank line, in order. `name` is the parser's
 * display name, falling back to the verbatim line when parsing yields nothing
 * (e.g. a bare quantity like "2") — the `name` column is NOT NULL + non-empty
 * (12b), so a fallback is required, never optional.
 */
export function ingredientRowsFromText(
  ingredientsText: string,
  householdId: string,
  dishId: string,
): IngredientInsert[] {
  return ingredientsText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, position) => {
      const parsed = parseIngredient(line);
      const name = parsed.name.trim() === "" ? parsed.rawText.trim() : parsed.name;
      return {
        household_id: householdId,
        dish_id: dishId,
        name,
        quantity: parsed.quantity,
        unit: parsed.unit,
        raw_text: parsed.rawText,
        position,
      };
    });
}

/**
 * Best-effort, non-atomic save (accepted seam — see module doc): insert the
 * dish, then insert its ingredients as one statement. A dish-saved /
 * ingredients-failed outcome still returns `ok: true` with
 * `ingredientsSaved: false` — the dish is real and editable; nothing is lost
 * except the ingredient rows, which the caller surfaces as a soft notice, not
 * an error. TODO (not built, tracked in the design doc): fold both writes into
 * a single SECURITY INVOKER RPC for true atomicity if this ever bites.
 */
export async function saveIngestedDish(
  supabase: Pick<DbClient, "from">,
  input: SaveIngestedDishInput,
): Promise<SaveIngestedDishResult> {
  const title = input.title.trim();
  if (title === "") {
    return { ok: false, error: "Give the recipe a title." };
  }

  // Scheme-validate every URL that could reach storage. Unlike a user-typed
  // optional field elsewhere in the app, these are DROPPED (not rejected with
  // an error) on failure — an unsafe image/source URL must never block an
  // otherwise-valid save (design doc error-handling table).
  const sourceUrl = safeHttpUrl(input.sourceUrl);
  const imageUrl = safeHttpUrl(input.imageUrl);

  const { data: dish, error: dishError } = await supabase
    .from("dishes")
    .insert({
      household_id: input.householdId,
      title,
      source_url: sourceUrl,
      image_url: imageUrl,
      prep_minutes: parseMinutesField(input.prepMinutes),
      cook_minutes: parseMinutesField(input.cookMinutes),
      total_minutes: parseMinutesField(input.totalMinutes),
      created_by: input.createdBy,
    })
    .select("id")
    .single();

  if (dishError || !dish) {
    return { ok: false, error: "We couldn't save that recipe. Please try again." };
  }

  const rows = ingredientRowsFromText(input.ingredientsText, input.householdId, dish.id);
  if (rows.length === 0) {
    return { ok: true, dishId: dish.id, ingredientsSaved: true };
  }

  const { error: ingredientsError } = await supabase.from("ingredients").insert(rows);
  return { ok: true, dishId: dish.id, ingredientsSaved: !ingredientsError };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/recipes/new/ingest-core.test.ts`
Expected: PASS — all 13 tests (5 from Task 1 + 8 new) green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add app/recipes/new/ingest-core.ts app/recipes/new/ingest-core.test.ts
git commit -m "feat(recipes): saveIngestedDish — best-effort dish+ingredients persist (#12c)"
```

---

### Task 3: `resolveRecipeActor` — identity from the verified session

**Files:**
- Create: `app/recipes/new/actor.ts`
- Create: `app/recipes/new/actor.test.ts`

**Interfaces:**
- Consumes: `SupabaseClient<Database>` (`auth.getUser`, `rpc("current_household_id")`, `from("members")`).
- Produces: `GENERIC_ERROR`, `RecipeActor = { householdId: string; memberId: string }`, `resolveRecipeActor(supabase): Promise<RecipeActor | null>` — consumed by Task 4's `actions.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// app/recipes/new/actor.test.ts
import { describe, expect, it } from "vitest";

import { resolveRecipeActor } from "./actor";

/**
 * Fail-closed identity resolution for the ingest Server Actions (issue #12c).
 * Mirrors app/board/actor.test.ts's resolveActor coverage, minus the week
 * concept this flow doesn't have.
 */

function actorClient(opts: {
  user: { id: string } | null;
  householdId: string | null;
  member: { id: string } | null;
}) {
  const client = {
    auth: { getUser: async () => ({ data: { user: opts.user } }) },
    rpc: async () => ({ data: opts.householdId }),
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: opts.member }),
        }),
      }),
    }),
  };
  return client as unknown as Parameters<typeof resolveRecipeActor>[0];
}

describe("resolveRecipeActor", () => {
  it("returns null when there is no verified session (fail closed)", async () => {
    const client = actorClient({ user: null, householdId: "hh-1", member: { id: "m1" } });
    expect(await resolveRecipeActor(client)).toBeNull();
  });

  it("returns null when the session has no household", async () => {
    const client = actorClient({ user: { id: "u1" }, householdId: null, member: { id: "m1" } });
    expect(await resolveRecipeActor(client)).toBeNull();
  });

  it("returns null when the user has no membership row", async () => {
    const client = actorClient({ user: { id: "u1" }, householdId: "hh-1", member: null });
    expect(await resolveRecipeActor(client)).toBeNull();
  });

  it("resolves household + member for a full session", async () => {
    const client = actorClient({ user: { id: "u1" }, householdId: "hh-1", member: { id: "m1" } });
    expect(await resolveRecipeActor(client)).toEqual({ householdId: "hh-1", memberId: "m1" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/recipes/new/actor.test.ts`
Expected: FAIL — `Cannot find module './actor'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
// app/recipes/new/actor.ts
/**
 * Caller identity for the recipe-ingest Server Actions (issue #12c). Mirrors
 * `app/board/actor.ts`'s `resolveActor` (deliberately NOT a `"use server"`
 * module — an internal helper, not a directly-invocable endpoint) but this flow
 * has no week concept, so it resolves only household + member id from the
 * VERIFIED session — never from request input. Fails closed (null) when the
 * session or membership can't be established; the middleware normally prevents
 * reaching here without both, but we don't assume it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DbClient = SupabaseClient<Database>;

export const GENERIC_ERROR = "Something went wrong. Reload and try again.";

export type RecipeActor = { householdId: string; memberId: string };

export async function resolveRecipeActor(
  supabase: Pick<DbClient, "auth" | "rpc" | "from">,
): Promise<RecipeActor | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: householdId } = await supabase.rpc("current_household_id");
  if (!householdId) return null;

  const { data: member } = await supabase
    .from("members")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (!member) return null;

  return { householdId, memberId: member.id };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/recipes/new/actor.test.ts`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add app/recipes/new/actor.ts app/recipes/new/actor.test.ts
git commit -m "feat(recipes): resolveRecipeActor — verified-session identity for ingest (#12c)"
```

---

### Task 4: `actions.ts` — the thin Server Action boundary

**Files:**
- Create: `app/recipes/new/actions.ts`

**Interfaces:**
- Consumes: `fetchRecipePreview`, `saveIngestedDish`, `EMPTY_RECIPE_PREVIEW`, `type RecipePreviewFields` (Task 1/2), `GENERIC_ERROR`, `resolveRecipeActor` (Task 3), `safeFetchHtml` (`@/lib/http/safe-fetch`), `emitEvent` (`@/lib/analytics/events`), `createServerComponentClient` (`@/lib/supabase/server-component`), `revalidatePath` (`next/cache`).
- Produces: `type PreviewState`, `fetchRecipePreviewAction(prev, formData): Promise<PreviewState>`, `type SaveState`, `saveIngestedDishAction(prev, formData): Promise<SaveState>` — consumed by Task 5's `recipe-ingest-form.tsx` (and mocked by its tests) and exercised live by Task 8's E2E test.

**Note on testing:** this module has no dedicated unit-test file, matching this repo's own precedent — `app/board/actions.ts` (the exact same "thin `use server"` wrapper over a tested `*-core.ts`" shape) has none either. Its only logic is wiring (build client → resolve actor → delegate → revalidate); the actual behavior is exhaustively covered by Task 1/2's `ingest-core.test.ts`, Task 3's `actor.test.ts`, Task 5's component tests (which mock this module and assert the `FormData` it's called with), and Task 8's E2E round trip. Verify with a typecheck instead of a red/green cycle.

- [ ] **Step 1: Write the module**

```ts
// app/recipes/new/actions.ts
"use server";

/**
 * Server Actions for the add-a-recipe flow (issue #12c) — the thin Next.js
 * boundary. Build the RLS-scoped cookie-session client (runs as the signed-in
 * user; no service-role key), resolve the caller's identity from the VERIFIED
 * session, delegate to the pure `ingest-core` orchestration (supplying the
 * REAL SSRF-guarded fetcher), then revalidate `/recipes`.
 *
 * `recipe_ingested` (ADR 0004) is emitted only on a URL-SOURCED save — a
 * by-hand add (no `sourceUrl`) is not "ingested". Analytics failures never
 * block or surface to the user (`emitEvent` fails closed internally).
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { emitEvent } from "@/lib/analytics/events";
import { safeFetchHtml } from "@/lib/http/safe-fetch";
import { createServerComponentClient } from "@/lib/supabase/server-component";

import { GENERIC_ERROR, resolveRecipeActor } from "./actor";
import {
  EMPTY_RECIPE_PREVIEW,
  fetchRecipePreview,
  saveIngestedDish,
  type RecipePreviewFields,
} from "./ingest-core";

export type PreviewState =
  | null
  | { ok: true; sourceUrl: string; preview: RecipePreviewFields }
  | { ok: false; notice: string; preview: RecipePreviewFields };

export async function fetchRecipePreviewAction(
  _prev: PreviewState,
  formData: FormData,
): Promise<PreviewState> {
  const supabase = await createServerComponentClient();
  const actor = await resolveRecipeActor(supabase);
  if (!actor) {
    return { ok: false, notice: GENERIC_ERROR, preview: EMPTY_RECIPE_PREVIEW };
  }

  return fetchRecipePreview(safeFetchHtml, String(formData.get("url") ?? ""));
}

// Success navigates away (PRG, kickoff resolution 2), so there is no on-page
// "saved" state — only the failure arm is a returned state.
export type SaveState = null | { error: string };

export async function saveIngestedDishAction(
  _prev: SaveState,
  formData: FormData,
): Promise<SaveState> {
  const supabase = await createServerComponentClient();
  const actor = await resolveRecipeActor(supabase);
  if (!actor) return { error: GENERIC_ERROR };

  const sourceUrl = String(formData.get("sourceUrl") ?? "").trim();

  const result = await saveIngestedDish(supabase, {
    householdId: actor.householdId,
    createdBy: actor.memberId,
    title: String(formData.get("title") ?? ""),
    sourceUrl,
    imageUrl: String(formData.get("imageUrl") ?? ""),
    prepMinutes: String(formData.get("prepMinutes") ?? ""),
    cookMinutes: String(formData.get("cookMinutes") ?? ""),
    totalMinutes: String(formData.get("totalMinutes") ?? ""),
    ingredientsText: String(formData.get("ingredients") ?? ""),
  });
  if (!result.ok) return { error: result.error };

  if (sourceUrl !== "") {
    await emitEvent(supabase, {
      householdId: actor.householdId,
      memberId: actor.memberId,
      eventType: "recipe_ingested",
      payload: { dishId: result.dishId },
    });
  }

  // Post/Redirect/Get to the saved recipe's canonical URL (kickoff resolution
  // 2). Leaving the user on /recipes/new with a populated form lets a back
  // button + re-submit create a DUPLICATE dish; redirecting to a resource URL
  // removes that entire edge-case class. `revalidatePath` still refreshes the
  // library behind the redirect. `redirect()` throws NEXT_REDIRECT, so nothing
  // after it runs and the success path never returns a value (its type is
  // `never`) — do NOT wrap it in a try/catch that swallows that control-flow
  // signal. A benign ingredients-partial save is not surfaced inline anymore;
  // the detail page simply shows the dish with no ingredient lines.
  revalidatePath("/recipes");
  redirect(`/recipes/${result.dishId}`);
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean (both actions type-check against `PreviewState`/`SaveState` and the `ingest-core`/`actor` exports from Tasks 1–3).

- [ ] **Step 3: Commit**

```bash
git add app/recipes/new/actions.ts
git commit -m "feat(recipes): wire the ingest Server Actions (fetch preview + save) (#12c)"
```

---

### Task 5: `RecipeIngestForm` — the two-stage client form

**Files:**
- Create: `app/recipes/new/recipe-ingest-form.tsx`
- Create: `app/recipes/new/recipe-ingest-form.test.tsx`

**Interfaces:**
- Consumes: `fetchRecipePreviewAction`, `saveIngestedDishAction`, `type PreviewState`, `type SaveState` (Task 4).
- Produces: `RecipeIngestForm()` (no props) — consumed by Task 6's `page.tsx`.

- [ ] **Step 1: Write the failing tests**

```tsx
// app/recipes/new/recipe-ingest-form.test.tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The form imports the "use server" actions module, which pulls in next/headers
// etc. Mock it so the client component renders in jsdom (we assert the UI
// wiring here; the action contract itself is covered by ingest-core.test.ts).
const actionMocks = vi.hoisted(() => ({
  fetchRecipePreviewAction: vi.fn(async () => null as unknown),
  saveIngestedDishAction: vi.fn(async () => null as unknown),
}));

vi.mock("./actions", () => actionMocks);

import { RecipeIngestForm } from "./recipe-ingest-form";

beforeEach(() => {
  actionMocks.fetchRecipePreviewAction.mockReset().mockResolvedValue(null);
  actionMocks.saveIngestedDishAction.mockReset().mockResolvedValue(null);
});

describe("RecipeIngestForm", () => {
  it("renders the URL fetch field and an empty, usable editor by default", () => {
    render(<RecipeIngestForm />);

    expect(screen.getByLabelText("Recipe URL")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fetch recipe" })).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toBeRequired();
    expect(screen.getByLabelText(/ingredients/i)).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save to library" })).toBeEnabled();
  });

  it("saves by hand without ever fetching a URL", async () => {
    // On success the real action redirects (PRG); the mock just resolves. We
    // assert the FormData contract the action is invoked with — the redirect
    // itself is covered by the Task 9 E2E round-trip, not in jsdom.
    render(<RecipeIngestForm />);

    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Skillet Chicken" },
    });
    fireEvent.change(screen.getByLabelText(/ingredients/i), {
      target: { value: "1 lb chicken thighs\n2 tbsp olive oil" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save to library" }));
    });

    expect(actionMocks.saveIngestedDishAction).toHaveBeenCalledTimes(1);
    const submitted = actionMocks.saveIngestedDishAction.mock.calls[0][1] as FormData;
    expect(submitted.get("title")).toBe("Skillet Chicken");
    expect(submitted.get("sourceUrl")).toBe("");
    expect(submitted.get("ingredients")).toBe("1 lb chicken thighs\n2 tbsp olive oil");
    expect(actionMocks.fetchRecipePreviewAction).not.toHaveBeenCalled();
  });

  it("populates the editable fields from a successful fetch", async () => {
    actionMocks.fetchRecipePreviewAction.mockResolvedValueOnce({
      ok: true,
      sourceUrl: "https://example.com/tacos",
      preview: {
        title: "Carnitas Tacos",
        imageUrl: "https://example.com/tacos.jpg",
        ingredientLines: ["2 lb pork shoulder", "1 tbsp ground cumin"],
        prepMinutes: 20,
        cookMinutes: 90,
        totalMinutes: 110,
      },
    });
    render(<RecipeIngestForm />);

    fireEvent.change(screen.getByLabelText("Recipe URL"), {
      target: { value: "https://example.com/tacos" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fetch recipe" }));
    });

    expect(screen.getByLabelText("Title")).toHaveValue("Carnitas Tacos");
    expect(screen.getByLabelText(/ingredients/i)).toHaveValue(
      "2 lb pork shoulder\n1 tbsp ground cumin",
    );
    expect(screen.getByLabelText(/prep/i)).toHaveValue(20);

    const hidden = document.querySelector('input[name="sourceUrl"]');
    expect(hidden).toHaveValue("https://example.com/tacos");
  });

  it("shows a friendly notice and leaves a usable empty editor when extraction fails", async () => {
    actionMocks.fetchRecipePreviewAction.mockResolvedValueOnce({
      ok: false,
      notice: "We couldn't find a recipe on that page. Add it by hand below.",
      preview: {
        title: "",
        imageUrl: null,
        ingredientLines: [],
        prepMinutes: null,
        cookMinutes: null,
        totalMinutes: null,
      },
    });
    render(<RecipeIngestForm />);

    fireEvent.change(screen.getByLabelText("Recipe URL"), {
      target: { value: "https://example.com/blog-post" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Fetch recipe" }));
    });

    expect(screen.getByText(/couldn't find a recipe.*add it by hand/i)).toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Save to library" })).toBeEnabled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/recipes/new/recipe-ingest-form.test.tsx`
Expected: FAIL — `Cannot find module './recipe-ingest-form'`.

- [ ] **Step 3: Write the minimal implementation**

```tsx
// app/recipes/new/recipe-ingest-form.tsx
"use client";

/**
 * The add-a-recipe screen's two-stage form (issue #12c): fetch+extract a
 * preview from a pasted URL (optional), then edit and Save to the library.
 * Nothing is persisted until Save — an abandoned fetch leaves no orphan dish.
 *
 * Ingredient editing is intentionally a single "one per line" textarea, not
 * per-row inputs: raw text is the source of truth (issue #11) and each line is
 * re-parsed via `parseIngredient` server-side on Save.
 *
 * Extraction failure (or skipping the fetch entirely) renders the SAME
 * editable form, empty — manual add-by-hand always works, never a dead end.
 */

import { useActionState, useEffect, useState } from "react";

import {
  fetchRecipePreviewAction,
  saveIngestedDishAction,
  type PreviewState,
  type SaveState,
} from "./actions";

type EditableFields = {
  title: string;
  imageUrl: string;
  prepMinutes: string;
  cookMinutes: string;
  totalMinutes: string;
  ingredientsText: string;
};

const EMPTY_FIELDS: EditableFields = {
  title: "",
  imageUrl: "",
  prepMinutes: "",
  cookMinutes: "",
  totalMinutes: "",
  ingredientsText: "",
};

function minutesToField(value: number | null): string {
  return value === null ? "" : String(value);
}

const inputClass =
  "border-input bg-background rounded-md border px-3 py-2 text-sm";
const buttonClass =
  "bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium disabled:opacity-60";

export function RecipeIngestForm() {
  const [previewState, fetchAction, fetchPending] = useActionState<PreviewState, FormData>(
    fetchRecipePreviewAction,
    null,
  );
  const [saveState, saveAction, savePending] = useActionState<SaveState, FormData>(
    saveIngestedDishAction,
    null,
  );

  const [fields, setFields] = useState<EditableFields>(EMPTY_FIELDS);
  const [sourceUrl, setSourceUrl] = useState("");

  useEffect(() => {
    if (previewState === null) return;
    setFields({
      title: previewState.preview.title,
      imageUrl: previewState.preview.imageUrl ?? "",
      prepMinutes: minutesToField(previewState.preview.prepMinutes),
      cookMinutes: minutesToField(previewState.preview.cookMinutes),
      totalMinutes: minutesToField(previewState.preview.totalMinutes),
      ingredientsText: previewState.preview.ingredientLines.join("\n"),
    });
    setSourceUrl(previewState.ok ? previewState.sourceUrl : "");
  }, [previewState]);

  const notice = previewState && !previewState.ok ? previewState.notice : null;

  return (
    <div className="space-y-8">
      <form action={fetchAction} className="flex flex-col gap-3 text-left">
        <h2 className="font-medium">Paste a recipe URL</h2>

        <label className="text-sm font-medium" htmlFor="ingest-url">
          Recipe URL
        </label>
        <input
          id="ingest-url"
          name="url"
          type="url"
          placeholder="https://…"
          className={inputClass}
        />

        <button type="submit" disabled={fetchPending} className={buttonClass}>
          {fetchPending ? "Fetching…" : "Fetch recipe"}
        </button>

        {notice ? (
          <p role="status" className="text-sm text-amber-700">
            {notice}
          </p>
        ) : null}
      </form>

      <form action={saveAction} className="flex flex-col gap-3 text-left">
        <h2 className="font-medium">Recipe details</h2>
        <input type="hidden" name="sourceUrl" value={sourceUrl} readOnly />

        <label className="text-sm font-medium" htmlFor="ingest-title">
          Title
        </label>
        <input
          id="ingest-title"
          name="title"
          required
          maxLength={200}
          placeholder="Carnitas tacos"
          value={fields.title}
          onChange={(e) => setFields((f) => ({ ...f, title: e.target.value }))}
          className={inputClass}
        />

        <label className="text-sm font-medium" htmlFor="ingest-image">
          Image URL (optional)
        </label>
        <input
          id="ingest-image"
          name="imageUrl"
          type="url"
          value={fields.imageUrl}
          onChange={(e) => setFields((f) => ({ ...f, imageUrl: e.target.value }))}
          className={inputClass}
        />

        <div className="flex gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium" htmlFor="ingest-prep">
              Prep (min)
            </label>
            <input
              id="ingest-prep"
              name="prepMinutes"
              type="number"
              min={0}
              value={fields.prepMinutes}
              onChange={(e) => setFields((f) => ({ ...f, prepMinutes: e.target.value }))}
              className={inputClass}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium" htmlFor="ingest-cook">
              Cook (min)
            </label>
            <input
              id="ingest-cook"
              name="cookMinutes"
              type="number"
              min={0}
              value={fields.cookMinutes}
              onChange={(e) => setFields((f) => ({ ...f, cookMinutes: e.target.value }))}
              className={inputClass}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium" htmlFor="ingest-total">
              Total (min)
            </label>
            <input
              id="ingest-total"
              name="totalMinutes"
              type="number"
              min={0}
              value={fields.totalMinutes}
              onChange={(e) => setFields((f) => ({ ...f, totalMinutes: e.target.value }))}
              className={inputClass}
            />
          </div>
        </div>

        <label className="text-sm font-medium" htmlFor="ingest-ingredients">
          Ingredients (one per line)
        </label>
        <textarea
          id="ingest-ingredients"
          name="ingredients"
          rows={8}
          placeholder={"2 lb pork shoulder\n1 tbsp ground cumin"}
          value={fields.ingredientsText}
          onChange={(e) => setFields((f) => ({ ...f, ingredientsText: e.target.value }))}
          className={inputClass}
        />

        {/* Success navigates away (PRG → /recipes/{id}); only the failure
            state renders inline. */}
        {saveState && "error" in saveState ? (
          <p role="alert" className="text-destructive text-sm">
            {saveState.error}
          </p>
        ) : null}

        <button type="submit" disabled={savePending} className={buttonClass}>
          {savePending ? "Saving…" : "Save to library"}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/recipes/new/recipe-ingest-form.test.tsx`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add app/recipes/new/recipe-ingest-form.tsx app/recipes/new/recipe-ingest-form.test.tsx
git commit -m "feat(recipes): RecipeIngestForm — fetch/preview + edit/save UI (#12c)"
```

---

### Task 6: `/recipes/new` route

**Files:**
- Create: `app/recipes/new/page.tsx`
- Create: `app/recipes/new/page.test.tsx`

**Interfaces:**
- Consumes: `AppNav` (`@/components/app-nav`), `RecipeIngestForm` (Task 5).
- Produces: the route itself (default export `NewRecipePage`) — consumed by Task 7's link and Task 8's E2E test (`page.goto("/recipes/new")`).

- [ ] **Step 1: Write the failing test**

```tsx
// app/recipes/new/page.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/recipes/new" }));
vi.mock("./actions", () => ({
  fetchRecipePreviewAction: vi.fn(async () => null),
  saveIngestedDishAction: vi.fn(async () => null),
}));

import NewRecipePage from "./page";

describe("NewRecipePage", () => {
  it("renders the global nav, a heading, and the ingest form", () => {
    render(<NewRecipePage />);
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /add a recipe/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Recipe URL")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/recipes/new/page.test.tsx`
Expected: FAIL — `Cannot find module './page'`.

- [ ] **Step 3: Write the minimal implementation**

```tsx
// app/recipes/new/page.tsx
import { AppNav } from "@/components/app-nav";

import { RecipeIngestForm } from "./recipe-ingest-form";

// safeFetchHtml (issue #76) opens raw sockets via node:http/https/dns/net — this
// route (and the Server Actions it invokes) must run in the Node.js runtime,
// not Edge, where those modules are unavailable. Pinned explicitly per the #12
// design of record's security requirements, even though Node is already this
// app's platform-wide default.
export const runtime = "nodejs";

// Behind the auth/household gate (deny-by-default middleware). Session-dependent
// shell — never prerender at build time.
export const dynamic = "force-dynamic";

/**
 * Add-a-recipe screen (issue #12c): paste a URL to fetch + extract a preview,
 * or skip straight to the by-hand editor. Nothing is persisted until Save —
 * see `recipe-ingest-form.tsx` for the two-stage fetch/save flow and
 * `ingest-core.ts` for the orchestration it wraps.
 */
export default function NewRecipePage() {
  return (
    <>
      <AppNav />
      <main className="mx-auto max-w-3xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Add a recipe</h1>
        <RecipeIngestForm />
      </main>
    </>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/recipes/new/page.test.tsx`
Expected: PASS — 1 test green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add app/recipes/new/page.tsx app/recipes/new/page.test.tsx
git commit -m "feat(recipes): add the /recipes/new route (#12c)"
```

---

### Task 7: Wire `/recipes` → `/recipes/new` ("Add a recipe" affordance)

Without this, the new screen ships with no way for a user to reach it — 12z's placeholder text ("coming next") is exactly the gap this closes. Still squarely 12c's remit (a link, not the 12d library list).

**Files:**
- Modify: `app/recipes/page.tsx`
- Modify: `app/recipes/page.test.tsx`

**Interfaces:**
- Consumes: `Link` (`next/link`).
- Produces: nothing new consumed elsewhere — this is a leaf UI change.

- [ ] **Step 1: Write the failing test**

Add this test to the existing `describe("RecipesPage shell", ...)` block in `app/recipes/page.test.tsx`:

```tsx
  it("links to the add-a-recipe screen", () => {
    render(<RecipesPage />);
    expect(screen.getByRole("link", { name: /add a recipe/i })).toHaveAttribute(
      "href",
      "/recipes/new",
    );
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/recipes/page.test.tsx`
Expected: FAIL — no link with an accessible name matching `/add a recipe/i` exists yet.

- [ ] **Step 3: Write the minimal implementation**

Replace the full contents of `app/recipes/page.tsx`:

```tsx
import Link from "next/link";

import { AppNav } from "@/components/app-nav";

// Behind the auth/household gate (deny-by-default middleware). Session-dependent
// shell — never prerender at build time.
export const dynamic = "force-dynamic";

/**
 * Recipes screen shell (issue #12z). The fetch -> edit -> save ingest flow
 * lives at /recipes/new (issue #12c); the library list itself is #12d. For now
 * this screen is just the shell + the entry point into the add flow.
 */
export default function RecipesPage() {
  return (
    <>
      <AppNav />
      <main className="mx-auto max-w-3xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Recipes</h1>
        <p className="text-muted-foreground text-sm">
          Your saved recipes will show up here — coming soon.
        </p>
        <Link
          href="/recipes/new"
          className="bg-primary text-primary-foreground inline-block rounded-md px-4 py-2 text-sm font-medium"
        >
          Add a recipe
        </Link>
      </main>
    </>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/recipes/page.test.tsx`
Expected: PASS — both tests (the pre-existing shell test and the new link test) green.

- [ ] **Step 5: Commit**

```bash
git add app/recipes/page.tsx app/recipes/page.test.tsx
git commit -m "feat(recipes): link the Recipes shell to the add-a-recipe screen (#12c)"
```

---

### Task 8: `/recipes/[id]` — read-only recipe detail page (PRG redirect target)

Kickoff resolution 3. This is the page Task 4's save action redirects to. A pure `loadRecipeDetail` loader (injected client, unit-tested for found + not-found) plus a thin async Server Component that calls it and `notFound()`s on a miss — mirroring `app/board/page.tsx` (async RSC + cookie-session client, itself unit-test-free in this repo). RLS scopes the fetch to the caller's household, so an id belonging to another household returns no row → the not-found boundary, never a cross-household read.

**Files:**
- Create: `app/recipes/[id]/detail-core.ts`
- Create: `app/recipes/[id]/detail-core.test.ts`
- Create: `app/recipes/[id]/page.tsx`

**Interfaces:**
- Consumes: `SupabaseClient<Database>` (`from("dishes")`, `from("ingredients")`) for the loader; `createServerComponentClient` (`@/lib/supabase/server-component`), `AppNav` (`@/components/app-nav`), `notFound` (`next/navigation`) for the page.
- Produces: `type RecipeDetail`, `loadRecipeDetail(supabase, id): Promise<RecipeDetail | null>` (loader) and the route itself (default export `RecipeDetailPage`) — the redirect target of Task 4 and the link target of 12d.

- [ ] **Step 1: Write the failing loader tests**

```ts
// app/recipes/[id]/detail-core.test.ts
import { describe, expect, it, vi } from "vitest";

import { loadRecipeDetail } from "./detail-core";

/**
 * `loadRecipeDetail` reads a dish + its ingredient lines through an INJECTED
 * client (no live DB). In production the cookie-session client's RLS scopes the
 * read to the caller's household, so a bad id OR another household's id both
 * surface as "no dish row" — the loader returns null and the page 404s. The
 * not-found branch is covered here; the found path end-to-end is Task 9's E2E.
 */

type DishRow = {
  id: string;
  title: string;
  image_url: string | null;
  source_url: string | null;
  prep_minutes: number | null;
  cook_minutes: number | null;
  total_minutes: number | null;
};

function detailClient(opts: {
  dish: DishRow | null;
  ingredients?: { raw_text: string }[];
}) {
  const from = vi.fn((table: string) => {
    if (table === "dishes") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: opts.dish, error: null }),
          }),
        }),
      };
    }
    return {
      select: () => ({
        eq: () => ({
          order: async () => ({ data: opts.ingredients ?? [], error: null }),
        }),
      }),
    };
  });
  return { from } as unknown as Parameters<typeof loadRecipeDetail>[0];
}

describe("loadRecipeDetail", () => {
  it("returns null when RLS yields no dish row (bad id OR another household's recipe)", async () => {
    const client = detailClient({ dish: null });
    expect(
      await loadRecipeDetail(client, "00000000-0000-0000-0000-000000000000"),
    ).toBeNull();
  });

  it("maps the dish and its ingredient lines (in position order) for a found recipe", async () => {
    const client = detailClient({
      dish: {
        id: "d1",
        title: "Carnitas Tacos",
        image_url: "https://example.com/tacos.jpg",
        source_url: "https://example.com/tacos",
        prep_minutes: 20,
        cook_minutes: 90,
        total_minutes: 110,
      },
      ingredients: [
        { raw_text: "2 lb pork shoulder" },
        { raw_text: "1 tbsp ground cumin" },
      ],
    });

    expect(await loadRecipeDetail(client, "d1")).toEqual({
      id: "d1",
      title: "Carnitas Tacos",
      imageUrl: "https://example.com/tacos.jpg",
      sourceUrl: "https://example.com/tacos",
      prepMinutes: 20,
      cookMinutes: 90,
      totalMinutes: 110,
      ingredientLines: ["2 lb pork shoulder", "1 tbsp ground cumin"],
    });
  });

  it("returns an empty ingredient-line list for a title-only recipe", async () => {
    const client = detailClient({
      dish: {
        id: "d2",
        title: "Just a title",
        image_url: null,
        source_url: null,
        prep_minutes: null,
        cook_minutes: null,
        total_minutes: null,
      },
      ingredients: [],
    });

    const detail = await loadRecipeDetail(client, "d2");
    expect(detail).not.toBeNull();
    expect(detail?.ingredientLines).toEqual([]);
    expect(detail?.imageUrl).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run "app/recipes/[id]/detail-core.test.ts"`
Expected: FAIL — `Cannot find module './detail-core'`.

- [ ] **Step 3: Write the minimal loader**

```ts
// app/recipes/[id]/detail-core.ts
/**
 * Read-only recipe detail loader (issue #12c, kickoff resolution 3). Pure over
 * an injected Supabase-like client (unit-tested without a live DB), exactly like
 * `app/recipes/new/ingest-core.ts`. In production the cookie-session client runs
 * as the signed-in user, so RLS + `public.current_household_id()` scope the read
 * to the caller's household: a dish id from ANOTHER household simply returns no
 * row, indistinguishable from a bad id — both yield `null`, and the page renders
 * the not-found boundary. There is no service-role key on this path.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

type DbClient = SupabaseClient<Database>;

export type RecipeDetail = {
  id: string;
  title: string;
  imageUrl: string | null;
  sourceUrl: string | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  totalMinutes: number | null;
  ingredientLines: string[];
};

export async function loadRecipeDetail(
  supabase: Pick<DbClient, "from">,
  id: string,
): Promise<RecipeDetail | null> {
  const { data: dish } = await supabase
    .from("dishes")
    .select(
      "id, title, image_url, source_url, prep_minutes, cook_minutes, total_minutes",
    )
    .eq("id", id)
    .maybeSingle();

  // No row = bad id OR another household's recipe (RLS). A malformed (non-uuid)
  // id comes back as a PostgREST error, not a throw — `maybeSingle` yields
  // `data: null` here too, so the page 404s instead of crashing.
  if (!dish) return null;

  const { data: ingredients } = await supabase
    .from("ingredients")
    .select("raw_text")
    .eq("dish_id", id)
    .order("position", { ascending: true });

  return {
    id: dish.id,
    title: dish.title,
    imageUrl: dish.image_url,
    sourceUrl: dish.source_url,
    prepMinutes: dish.prep_minutes,
    cookMinutes: dish.cook_minutes,
    totalMinutes: dish.total_minutes,
    ingredientLines: (ingredients ?? []).map((row) => row.raw_text),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run "app/recipes/[id]/detail-core.test.ts"`
Expected: PASS — 3 tests green.

- [ ] **Step 5: Write the detail-page Server Component**

```tsx
// app/recipes/[id]/page.tsx
import { notFound } from "next/navigation";

import { AppNav } from "@/components/app-nav";
import { createServerComponentClient } from "@/lib/supabase/server-component";

import { loadRecipeDetail } from "./detail-core";

// Behind the auth/household gate (deny-by-default middleware). Session-dependent
// + RLS-scoped read — never prerender at build time.
export const dynamic = "force-dynamic";

/**
 * Read-only recipe detail page (issue #12c, kickoff resolution 3) — the PRG
 * redirect target after a save, and 12d's library-list link target. Mirrors
 * `app/board/page.tsx`: an async Server Component whose queries all run through
 * the RLS-scoped cookie session. A miss (bad id or another household's recipe)
 * renders the not-found boundary, never a crash and never a cross-household
 * read. Untrusted text (title, ingredient lines) renders as plain React
 * children (escaped by construction) — no `dangerouslySetInnerHTML`.
 */
export default async function RecipeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createServerComponentClient();
  const recipe = await loadRecipeDetail(supabase, id);
  if (!recipe) notFound();

  const times = [
    recipe.prepMinutes !== null ? { label: "Prep", value: recipe.prepMinutes } : null,
    recipe.cookMinutes !== null ? { label: "Cook", value: recipe.cookMinutes } : null,
    recipe.totalMinutes !== null ? { label: "Total", value: recipe.totalMinutes } : null,
  ].filter((t): t is { label: string; value: number } => t !== null);

  return (
    <>
      <AppNav />
      <main className="mx-auto max-w-3xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">{recipe.title}</h1>

        {recipe.imageUrl ? (
          // A user-supplied external image URL, already scheme-validated via
          // safeHttpUrl before it was ever stored. A plain <img> is deliberately
          // preferred over next/image here: routing an arbitrary host through
          // the image optimizer would add a server-side fetch (an SSRF surface)
          // for no benefit.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={recipe.imageUrl}
            alt=""
            className="max-h-64 rounded-md object-cover"
          />
        ) : null}

        {times.length > 0 ? (
          <dl className="flex gap-6 text-sm">
            {times.map((t) => (
              <div key={t.label}>
                <dt className="text-muted-foreground">{t.label}</dt>
                <dd className="font-medium">{t.value} min</dd>
              </div>
            ))}
          </dl>
        ) : null}

        <section className="space-y-2">
          <h2 className="font-medium">Ingredients</h2>
          {recipe.ingredientLines.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {recipe.ingredientLines.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">No ingredients yet.</p>
          )}
        </section>

        {recipe.sourceUrl ? (
          <a
            href={recipe.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="text-primary inline-block text-sm underline underline-offset-4"
          >
            View original recipe
          </a>
        ) : null}
      </main>
    </>
  );
}
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add "app/recipes/[id]/detail-core.ts" "app/recipes/[id]/detail-core.test.ts" "app/recipes/[id]/page.tsx"
git commit -m "feat(recipes): read-only /recipes/[id] detail page + loader (#12c)"
```

---

### Task 9: Authenticated E2E — the by-hand add flow

**Why by-hand only (not the URL-fetch path):** the URL-fetch path would require either a real internet URL (network-dependent, slow, flaky in CI, and not hermetic — the recipe page's markup could change or the host could go down) or standing up a local fixture HTTP server just for this one test. Neither is warranted: `fetchRecipePreview`'s fetch → extract → scrub pipeline is exhaustively covered offline in Task 1 (`ingest-core.test.ts`, injected fake fetcher — including the SSRF-block and no-JSON-LD-Recipe cases), and the client-side wiring of a successful/failed fetch is covered by Task 5's component tests with the Server Action mocked. This E2E test proves the one thing those two layers can't: the full authenticated stack — RLS-scoped insert as the real signed-in user, `revalidatePath`, the PRG redirect, and the rendered read-only detail page (Task 8) — round-trips for real, using the by-hand path (self-contained, no network egress required). It is also the found-path coverage for the detail page.

**Files:**
- Create: `e2e/authed/recipes.spec.ts`

**Interfaces:**
- Consumes: the seeded `authed` Playwright project (session as user A, per `playwright.config.ts` + `e2e/auth.setup.ts` — no changes needed, `e2e/authed/*.spec.ts` is already matched).

- [ ] **Step 1: Write the test**

```ts
// e2e/authed/recipes.spec.ts
import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

/**
 * Authenticated recipe-ingest flow (issue #12c): the by-hand add path.
 *
 * The URL-fetch path is deliberately NOT exercised here against a real
 * internet URL — see the plan's Task 9 rationale (ingest-core.test.ts and
 * recipe-ingest-form.test.tsx already cover it offline and deterministically).
 * This test proves the full authenticated stack round-trips for real: an
 * RLS-scoped insert as the signed-in user, the PRG redirect, and the rendered
 * read-only detail page (Task 8).
 */
test("adding a recipe by hand (no URL) saves it and lands on its detail page", async ({
  page,
}) => {
  const title = `E2E Hand-Added Dish ${randomUUID().slice(0, 8)}`;

  await page.goto("/recipes/new");

  await page.getByLabel("Title").fill(title);
  await page.getByLabel(/ingredients/i).fill("2 cups flour\n1 tsp salt");
  await page.getByRole("button", { name: "Save to library" }).click();

  // PRG (kickoff resolution 2): the save redirects to the new recipe's
  // canonical URL, and the read-only detail page shows what we just saved.
  await expect(page).toHaveURL(/\/recipes\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await expect(page.getByText("2 cups flour")).toBeVisible();
  await expect(page.getByText("1 tsp salt")).toBeVisible();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run build && npx playwright test --project=authed e2e/authed/recipes.spec.ts`
Expected: FAIL before Tasks 1–8 exist (route/module not found); once this task runs LAST (after Task 8), expect PASS — confirm by running this command as the final verification step of the whole plan, against a local Supabase stack (`npm run db:start` first) and a fresh production build.

- [ ] **Step 3: Run to verify it passes**

Run: `npm run db:start && npm run build && npx playwright test --project=authed e2e/authed/recipes.spec.ts`
Expected: PASS — the seeded user reaches `/recipes/new`, saves a hand-entered dish, and sees the success message.

- [ ] **Step 4: Commit**

```bash
git add e2e/authed/recipes.spec.ts
git commit -m "test(e2e): authenticated by-hand recipe-add round trip (#12c)"
```

---

## Self-Review

**1. Spec coverage (12c, against `docs/superpowers/specs/2026-07-22-recipe-ingest-design.md`):**
- Page (not modal) at `/recipes/new`, deep-linkable, reachable from `/recipes` → Tasks 6, 7.
- Fetch is preview-only, nothing persisted until Save → Task 1 (`fetchRecipePreview` never touches `supabase`) + Task 5 (two separate forms/actions).
- Ingredient editing = raw-text lines, re-parsed via `parseIngredient` on Save, `position` = row order → Task 2 (`ingredientRowsFromText`).
- By-hand path (no URL) works → Task 2 tests (`sourceUrl: ""`), Task 5 component test, Task 8 E2E.
- Extraction failure/partial → same editable form + friendly notice, never a dead end → Task 1 tests (`EMPTY_RECIPE_PREVIEW` on every failure path) + Task 5 component test.
- Persistence best-effort, non-atomic, dish-saved/ingredients-failed is benign → Task 2 (`ingredientsSaved: false` path) + Task 5 (soft notice, not an error).
- `source_url`/`image_url` scheme-validated before persist; unsafe `image_url` dropped, not blocking → Task 1 (`javascript:` in JSON-LD dropped before reaching the client) + Task 2 (`javascript:` in the save input dropped; save still succeeds).
- Fetch only via `safeFetchHtml`; runtime pinned to Node → Task 4 (`safeFetchHtml` is the only injected fetcher in production) + Task 6 (`export const runtime = "nodejs"`).
- Identity/household from verified session, never request input → Task 3 (`resolveRecipeActor`) + Task 4 (every action calls it first).
- Extracted/user text rendered as text, no `dangerouslySetInnerHTML` → Task 5 (plain controlled inputs/textarea throughout; explicitly called out in the module doc and Global Constraints).
- `recipe_ingested` analytics event on URL-sourced save only → Task 4 (`if (sourceUrl !== "")`).
- Explicit security test coverage requested by the brief: SSRF/blocked-address fetch rejection surfaced → Task 1 test `"falls back ... when the fetch is blocked"`; `javascript:` image URL dropped (both extracted-from-page and hand-typed) → Task 1 + Task 2 tests; no-JSON-LD-Recipe page surfaces a friendly notice, not a crash → Task 1 test `"falls back ... when the page has no Recipe JSON-LD"` + Task 5 component test.
- Testing section's three layers (`*-core` unit tests, component tests, QA/security/PO review) → Tasks 1–2 (core), Task 5 (component), Task 8 (E2E round trip); the non-author security review and PO acceptance are outside this plan's scope (separate gates run by other personas, per the design doc).

**2. Placeholder scan:** none found — every step contains complete, runnable code; no "TBD"/"add error handling"/"similar to Task N" phrasing. The one deliberately-omitted item (a live thumbnail `<img>` preview mentioned in the design doc's flow sketch) is called out explicitly below as a scope trim, not silently dropped.

**3. Type/name consistency:** `RecipePreviewFields` / `EMPTY_RECIPE_PREVIEW` / `FetchHtml` / `FetchPreviewResult` (Task 1) are imported unchanged by Task 4's `actions.ts` and referenced by shape in Task 5's mocked test fixtures. `SaveIngestedDishInput` / `SaveIngestedDishResult` / `ingredientRowsFromText` (Task 2) match the field names Task 4 builds from `FormData` (`title`, `sourceUrl`, `imageUrl`, `prepMinutes`, `cookMinutes`, `totalMinutes`, `ingredientsText`) and the `<input name="...">`/`<textarea name="ingredients">` attributes Task 5 renders. `RecipeActor { householdId, memberId }` (Task 3) matches the two fields Task 4 reads off `actor`. `PreviewState`/`SaveState` (Task 4) match the discriminants (`ok`, `error`, `saved`) Task 5's UI branches on (`"error" in saveState`, `"saved" in saveState`, `previewState.ok`).

## Design decisions made beyond the given brief (flagging for review)

- **Added Task 7** (wire `/recipes` → `/recipes/new`): not explicitly requested, but without it this brick ships unreachable from the UI — 12z's own placeholder copy says "coming next," and the design doc's 12c section says `/recipes` gets "an Add a recipe affordance" either way. Small, in-scope, does not touch 12d's list view.
- **Local `app/recipes/new/actor.ts` instead of reusing `app/board/actor.ts`:** matches this repo's existing pattern of one small actor resolver per route group (`app/board/actor.ts` carries board-only `weekStartDay`; `app/current-member.ts` is its own separate resolver for the home screen) rather than a shared cross-feature import, which would couple `/recipes` to `/board`'s module.
- **`saveIngestedDish` takes raw strings, not pre-parsed numbers**, for `prepMinutes`/`cookMinutes`/`totalMinutes`/`sourceUrl`/`imageUrl` — mirrors `proposeNewDish`'s exact convention (validation/parsing happens inside the tested core, not in the thin, untested `actions.ts`), keeping `actions.ts` a pure `String(formData.get(...))` pass-through.
- **Dropped the design doc's live `<img>` thumbnail preview** from the editor (mentioned in the flow sketch as "(thumbnail if present)"). The Image URL field is still shown, editable, and server-validated; I left out the extra rendered preview to keep the component and its test surface smaller (YAGNI) — trivial to add later as a pure presentational addition with no security surface, since `safeHttpUrl` already gates what reaches the client.
- **Textarea, not per-row inputs, for ingredients** — this was explicitly permitted by the task's locked decision #2, but flagging that it's a deliberate deviation from the design doc's flow sketch (which shows individual add/remove rows), traded for a much smaller, more testable component.

## Open questions for the Product Owner / human

- None blocking. The earlier duplicate-dish concern (form stays populated → a
  second Save creates a SECOND dish) is **resolved by kickoff resolution 2**:
  the save Post/Redirect/Gets to `/recipes/{id}`, so the populated `/recipes/new`
  form no longer lingers behind the back button. The "Saved — add another?"
  reset affordance is deferred → issue **#88**; editing an already-saved recipe
  is deferred → issue **#89**.
