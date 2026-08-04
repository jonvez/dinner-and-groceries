# 12d — Recipes library list Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/recipes` becomes the household's read-only recipe library: it lists every saved `dishes` row (newest first), each linking to its `/recipes/{id}` detail page (#12c), shows a friendly empty state when there are none, and always offers an "Add a recipe" entry point to `/recipes/new`. No search, no edit, no delete, no pagination — all explicitly out of scope / backlogged.

**Architecture:** A pure presentational component, `RecipeLibraryList` (`app/recipes/recipe-library-list.tsx`), takes a plain `{ id, title }[]` array and renders the list-or-empty-state — no framework glue, fully covered by Testing Library unit tests. `app/recipes/page.tsx` becomes a thin **async** Server Component (mirrors `app/board/page.tsx`'s shape): it queries `dishes` through the RLS-scoped cookie-session client and hands the rows straight to `RecipeLibraryList`. This is a pure read — no Server Action, no mutation, no new table.

**Tech Stack:** Next.js 15 App Router (React Server Components), TypeScript, Supabase (`@supabase/supabase-js`, RLS in force), Vitest + Testing Library (jsdom) for the presentational component, Playwright (authed E2E project) for the end-to-end wiring.

## Global Constraints

- **No service-role key.** The list query runs as the signed-in user through `createServerComponentClient`; RLS + `public.current_household_id()` scope the rows to the caller's household — no manual `household_id` filter anywhere in this brick.
- **Untrusted text (recipe titles) is rendered as text only** — plain React children, never `dangerouslySetInnerHTML`.
- **Command hygiene:** explicit `git add <path>` (never `-A`), no `cd`-compounded git commands, real non-interactive flags.
- **Conventional commits** (`feat:`, `test:`, `chore:`) with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` on every commit.
- **PRs only, human merges** — matches this repo's workflow for 12a/12b/12c/12z (branch-protected, reviewed PRs). Do not push directly to `main`.
- **Hard dependency on #12c — build and merge this brick AFTER 12c is merged.** 12c's Task 6/7 create `app/recipes/new/` (the ingest flow) and leave `app/recipes/page.tsx` with an INTERIM "Add a recipe" link as a placeholder body. 12c's Kickoff Resolution 3 also adds `app/recipes/[id]/page.tsx` — the read-only detail route this brick's list links to. **12d REPLACES `app/recipes/page.tsx`'s interim placeholder body with the real list** (Task 2 below) and its link target (`/recipes/{id}`) must already exist. Do not start Task 2 (or Task 3's E2E) against an unmerged 12c.
- **Assumption flagged for the implementer (Task 3):** 12c's plan document, as drafted, was later amended by a same-day kickoff resolution (Resolution 2: successful save does a Post/Redirect/Get to `/recipes/{id}` instead of staying on `/recipes/new`). Task 3's E2E test is written against that resolution's documented behavior, not the plan's original pre-resolution code sample. Before writing Task 3, open the merged `e2e/authed/recipes.spec.ts` and `app/recipes/[id]/page.tsx` to confirm the actual redirect URL shape and the detail page's heading match this task's selectors; adjust if 12c's landed implementation differs.

## File Structure

- `app/recipes/recipe-library-list.tsx` — **create.** Pure presentational component: `dishes: { id: string; title: string }[]` in, the list-or-empty-state markup out. No data fetching, no `"use client"` needed (no interactivity).
- `app/recipes/recipe-library-list.test.tsx` — **create.** Testing Library coverage: populated list (links + order), empty state, the "Add a recipe" entry point present in both states, and an explicit no-HTML-injection check on a title containing markup.
- `app/recipes/page.tsx` — **modify.** Replace 12c's interim "Add a recipe"-only body with the real async Server Component: query `dishes`, render `<RecipeLibraryList dishes={...} />`.
- `app/recipes/page.test.tsx` — **delete.** Retired: `RecipesPage` becomes an async Server Component querying Supabase directly, which React Testing Library's `render()` cannot invoke outside Next's RSC pipeline — this repo's own `app/board/page.tsx` (the same async-fetch-then-render shape) has no `page.test.tsx` for exactly this reason. Coverage moves to `recipe-library-list.test.tsx` (Task 1, the presentational logic) and the E2E test (Task 3, the real wiring).
- `e2e/authed/recipes.spec.ts` — **modify.** Append one authenticated test: save a dish, then confirm it appears in `/recipes`'s list and its link opens the correct detail page.

---

### Task 1: `RecipeLibraryList` — pure presentational list + empty state

**Files:**
- Create: `app/recipes/recipe-library-list.tsx`
- Create: `app/recipes/recipe-library-list.test.tsx`

**Interfaces:**
- Consumes: `Link` (`next/link`).
- Produces: `type LibraryDish = { id: string; title: string }`, `RecipeLibraryList({ dishes }: { dishes: LibraryDish[] })` — consumed by Task 2's `page.tsx`.

- [ ] **Step 1: Write the failing tests**

```tsx
// app/recipes/recipe-library-list.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RecipeLibraryList, type LibraryDish } from "./recipe-library-list";

/**
 * The read-only recipe library list (issue #12d): every saved dish, newest
 * first (ordering is the caller's responsibility — this component just
 * renders the array it's given), each linking to its /recipes/{id} detail
 * page (#12c), plus a friendly empty state and an always-present "Add a
 * recipe" entry point. No search/edit/delete/pagination in this brick.
 */

describe("RecipeLibraryList", () => {
  it("renders each saved dish as a link to its detail page, in the given order", () => {
    const dishes: LibraryDish[] = [
      { id: "d1", title: "Carnitas Tacos" },
      { id: "d2", title: "Skillet Chicken" },
    ];
    render(<RecipeLibraryList dishes={dishes} />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Carnitas Tacos");
    expect(items[1]).toHaveTextContent("Skillet Chicken");

    expect(screen.getByRole("link", { name: "Carnitas Tacos" })).toHaveAttribute(
      "href",
      "/recipes/d1",
    );
    expect(screen.getByRole("link", { name: "Skillet Chicken" })).toHaveAttribute(
      "href",
      "/recipes/d2",
    );
  });

  it("shows a friendly empty state when there are no saved recipes", () => {
    render(<RecipeLibraryList dishes={[]} />);

    expect(screen.getByText(/haven.t saved any recipes yet/i)).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });

  it("always shows the Add a recipe entry point, whether the library is empty or populated", () => {
    const { rerender } = render(<RecipeLibraryList dishes={[]} />);
    expect(screen.getByRole("link", { name: "Add a recipe" })).toHaveAttribute(
      "href",
      "/recipes/new",
    );

    rerender(<RecipeLibraryList dishes={[{ id: "d1", title: "Tacos" }]} />);
    expect(screen.getByRole("link", { name: "Add a recipe" })).toHaveAttribute(
      "href",
      "/recipes/new",
    );
  });

  it("renders a title containing markup as literal text, never as HTML", () => {
    const dishes: LibraryDish[] = [
      { id: "d1", title: "<img src=x onerror=alert(1)>Evil Recipe" },
    ];
    render(<RecipeLibraryList dishes={dishes} />);

    expect(
      screen.getByText("<img src=x onerror=alert(1)>Evil Recipe"),
    ).toBeInTheDocument();
    expect(document.querySelector("img")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/recipes/recipe-library-list.test.tsx`
Expected: FAIL — `Cannot find module './recipe-library-list'`.

- [ ] **Step 3: Write the minimal implementation**

```tsx
// app/recipes/recipe-library-list.tsx
import Link from "next/link";

/**
 * The read-only recipe library list (issue #12d) — pure presentational
 * component, no data fetching. `page.tsx` queries `dishes` through the
 * RLS-scoped client and passes the plain result straight through; this
 * component only knows how to render a list-or-empty-state.
 *
 * `title` is untrusted (user-entered) text. It is rendered as a plain React
 * child — never `dangerouslySetInnerHTML` — so it is escaped by construction;
 * see the explicit markup-in-title test in recipe-library-list.test.tsx.
 */

export type LibraryDish = {
  id: string;
  title: string;
};

export type RecipeLibraryListProps = {
  dishes: LibraryDish[];
};

const addRecipeLinkClass =
  "bg-primary text-primary-foreground inline-block rounded-md px-4 py-2 text-sm font-medium";

export function RecipeLibraryList({ dishes }: RecipeLibraryListProps) {
  return (
    <div className="space-y-4">
      <Link href="/recipes/new" className={addRecipeLinkClass}>
        Add a recipe
      </Link>

      {dishes.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          You haven&apos;t saved any recipes yet.
        </p>
      ) : (
        <ul className="divide-border divide-y">
          {dishes.map((dish) => (
            <li key={dish.id} className="py-2">
              <Link
                href={`/recipes/${dish.id}`}
                className="text-sm font-medium underline-offset-4 hover:underline"
              >
                {dish.title}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run app/recipes/recipe-library-list.test.tsx`
Expected: PASS — 4 tests green.

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add app/recipes/recipe-library-list.tsx app/recipes/recipe-library-list.test.tsx
git commit -m "feat(recipes): RecipeLibraryList — pure list + empty-state component (#12d)"
```

---

### Task 2: Wire `/recipes` to the real library query

**Files:**
- Modify: `app/recipes/page.tsx`
- Delete: `app/recipes/page.test.tsx`

**Interfaces:**
- Consumes: `AppNav` (`@/components/app-nav`), `createServerComponentClient` (`@/lib/supabase/server-component`), `RecipeLibraryList`, `type LibraryDish` (Task 1).
- Produces: the route itself (default export `RecipesPage`) — no other module imports it.

**Note on testing (why this task has no red/green cycle for `page.tsx` itself):** `RecipesPage` becomes an `async` Server Component that queries Supabase directly — the exact shape of `app/board/page.tsx`, which this repo already ships with **no** dedicated `page.test.tsx` (confirmed: only `app/board/board-grid.test.tsx`, `proposal-pool.test.tsx`, `propose-form.test.tsx` exist, testing the presentational pieces `page.tsx` composes). React Testing Library's `render()` cannot invoke an async function component outside Next's RSC render pipeline, so a direct unit test isn't viable here either. This task therefore replaces Step 1/2's usual "write/run the failing test" with deleting the now-inapplicable placeholder test, and substitutes a typecheck for the pass/fail cycle. Behavioral coverage lives in Task 1 (`recipe-library-list.test.tsx`, exhaustive over the presentational logic `page.tsx` delegates to) and Task 3 (E2E, the real RLS-scoped query + rendering wired together).

- [ ] **Step 1: Delete the retired placeholder test**

```bash
git rm app/recipes/page.test.tsx
```

(This is a working step, not the commit — the deletion is staged together with Step 2's `page.tsx` change in Step 4's commit.)

- [ ] **Step 2: Replace `page.tsx`'s body with the real query + list**

Replace the full contents of `app/recipes/page.tsx`:

```tsx
// app/recipes/page.tsx
import { AppNav } from "@/components/app-nav";
import { createServerComponentClient } from "@/lib/supabase/server-component";

import { RecipeLibraryList, type LibraryDish } from "./recipe-library-list";

// Behind the auth/household gate (deny-by-default middleware); the query
// below runs as the signed-in user. Session-dependent — never prerender.
export const dynamic = "force-dynamic";

/**
 * The household's read-only recipe library (issue #12d). Lists every saved
 * `dishes` row, newest first, each linking to its `/recipes/{id}` detail page
 * (#12c). No search, edit, delete, or pagination — those are separate,
 * backlogged bricks. RLS (`public.current_household_id()`) scopes the query
 * to the caller's household; there is no manual `household_id` filter and no
 * service-role client, matching every other read in this app (`app/board/page.tsx`).
 */
export default async function RecipesPage() {
  const supabase = await createServerComponentClient();

  const { data } = await supabase
    .from("dishes")
    .select("id, title, created_at")
    .order("created_at", { ascending: false });

  const dishes: LibraryDish[] = (data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
  }));

  return (
    <>
      <AppNav />
      <main className="mx-auto max-w-3xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Recipes</h1>
        <RecipeLibraryList dishes={dishes} />
      </main>
    </>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean — `dishes.select("id, title, created_at")`'s inferred row type satisfies `LibraryDish` after the map; no leftover reference to the deleted test file.

- [ ] **Step 4: Run the full unit suite**

Run: `npx vitest run`
Expected: PASS — no failures from the deleted `app/recipes/page.test.tsx` (it's gone) and `recipe-library-list.test.tsx` (Task 1) still green.

- [ ] **Step 5: Commit**

```bash
git add app/recipes/page.tsx
git add app/recipes/page.test.tsx
git commit -m "feat(recipes): wire /recipes to the real household recipe library (#12d)"
```

(`git add` on a path already staged for deletion by `git rm` is a no-op that just confirms it's included — this keeps both changes in one atomic commit.)

---

### Task 3: Authenticated E2E — a saved recipe shows in the list and links to its detail page

**Why extend the E2E rather than rely on component coverage alone:** Task 1's component test exhaustively covers `RecipeLibraryList`'s *rendering* logic (links, order, empty state, no-HTML-injection) against a plain in-memory array — it proves nothing about the RLS-scoped query in `page.tsx` actually returning the caller's own household's rows, or about the `/recipes/{id}` href actually resolving to a working detail page. Those are exactly the two things only a real authenticated round trip can prove, so this brick still needs one.

**Files:**
- Modify: `e2e/authed/recipes.spec.ts`

**Interfaces:**
- Consumes: the seeded `authed` Playwright project (session as user A, per `playwright.config.ts` + `e2e/auth.setup.ts`); `/recipes/new`'s save flow and `/recipes/{id}`'s detail page, both from #12c.

- [ ] **Step 1: Write the test**

Append to `e2e/authed/recipes.spec.ts` (after the existing by-hand-add test):

```ts
/**
 * The recipe library list (issue #12d): a saved dish shows up on /recipes
 * and its link opens the correct detail page. Assumes 12c's Kickoff
 * Resolution 2 (successful save does a Post/Redirect/Get to /recipes/{id})
 * — see this plan's Global Constraints for the flagged assumption to verify
 * against the actually-merged 12c before running this.
 */
test("a saved recipe appears in the library list and its link opens the correct detail page", async ({
  page,
}) => {
  const title = `E2E Library Dish ${randomUUID().slice(0, 8)}`;

  await page.goto("/recipes/new");
  await page.getByLabel("Title").fill(title);
  await page.getByRole("button", { name: "Save to library" }).click();

  // Save redirects (PRG) straight to the new dish's detail page.
  await expect(page).toHaveURL(/\/recipes\/[^/]+$/);
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  await page.goto("/recipes");
  const libraryLink = page.getByRole("link", { name: title });
  await expect(libraryLink).toBeVisible();

  await libraryLink.click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run db:start && npm run build && npx playwright test --project=authed e2e/authed/recipes.spec.ts`
Expected: FAIL before Tasks 1–2 exist (no library list rendered on `/recipes`, so the link is never found).

- [ ] **Step 3: Run to verify it passes**

Run: `npx playwright test --project=authed e2e/authed/recipes.spec.ts`
Expected: PASS — the saved dish's title appears as a link on `/recipes`, and following it lands back on its detail page.

- [ ] **Step 4: Commit**

```bash
git add e2e/authed/recipes.spec.ts
git commit -m "test(e2e): saved recipe shows in the library list and links to its detail page (#12d)"
```

---

## Self-Review

**1. Spec coverage (12d against the brief above):**
- Lists saved dishes → Task 1 (`RecipeLibraryList` renders each dish) + Task 2 (`page.tsx` queries `dishes`).
- Links each to `/recipes/{id}` → Task 1's `href="/recipes/${dish.id}"` test + Task 3's E2E click-through.
- Empty state → Task 1's dedicated empty-state test.
- "Add a recipe" entry point retained → Task 1's "always shows... whether empty or populated" test.
- No search/edit/delete/pagination → none built; `RecipeLibraryListProps` carries only `dishes`, no query/mutation props.
- RLS scoping, no manual household filter, no service-role → Task 2's query comment + Global Constraints; matches `app/board/page.tsx`'s existing precedent exactly.
- Untrusted title rendered as text only → Task 1's explicit markup-in-title test (no `<img>` created, text preserved literally).
- 12c dependency sequencing → stated in Global Constraints and Task 2's file-structure note.

**2. Placeholder scan:** none found — every step contains complete, runnable code or an explicit, justified non-code step (the Task 2 test-file deletion, argued from this repo's own `app/board/page.tsx` precedent, not asserted without evidence).

**3. Type/name consistency:** `LibraryDish { id, title }` (Task 1) is exactly what Task 2's `page.tsx` maps the Supabase row into before passing to `RecipeLibraryList`; no other shape is introduced. `RecipeLibraryListProps.dishes` matches the prop name used in Task 2's JSX (`<RecipeLibraryList dishes={dishes} />`).

## Design decisions made beyond the given brief (flagging for review)

- **`page.tsx` gets no dedicated unit test** — a deliberate deviation from this plan's own Task 1/others' red-green cycle, justified by matching this repo's existing, un-contested precedent (`app/board/page.tsx`) rather than inventing a new testing strategy for one file. Flagging in case the human wants a different call here (e.g., an integration-style test with a fully mocked Supabase client), but I'd recommend against it — it would be the first such test in the codebase and adds a maintenance surface (mocking the full builder chain) for coverage the E2E test already provides more faithfully.
- **Ordering (`created_at` descending) is baked into the query, not exposed as a component prop** — YAGNI; nothing in the brief asks for re-orderable views, and `RecipeLibraryList` staying order-agnostic (it just renders what it's given) keeps it trivial to test.

## Open questions for the Product Owner / human

- None blocking. One flagged assumption (not a question, but worth a second pair of eyes): Task 3's E2E test is written against 12c's **Kickoff Resolution 2** (save → redirect to `/recipes/{id}`) rather than 12c's original plan-document code sample (which showed an inline "Saved to your library" message with no redirect). If 12c ultimately shipped differently than its own resolution states, Task 3's selectors will need a small adjustment — called out explicitly in this plan's Global Constraints so whoever executes Task 3 checks first rather than guessing.
