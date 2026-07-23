# 12z — App shell + global navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a shared global navigation and land an empty `/recipes` route, so the app graduates from single-screen to a navigable shell that Slices 1c/1d/1e hang off.

**Architecture:** A single client `AppNav` component (`components/app-nav.tsx`) using `usePathname` to mark the current section, rendered explicitly at the top of each authenticated screen (Home, Board, and the new Recipes route). Login/join deliberately do not render it. No route-group restructuring, no middleware change — `/recipes` is already protected by the deny-by-default auth routing.

**Tech Stack:** Next.js 15 App Router (TS), Tailwind + shadcn tokens, Vitest + React Testing Library (jsdom).

## Global Constraints

- **Design of record:** `docs/superpowers/specs/2026-07-22-recipe-ingest-design.md`, section "12z — app shell + global navigation". YAGNI line: **enough nav to reach the screens, not a nav framework** — plain links + current-section indication, no breadcrumbs/nested menus/animation.
- **Nav links (exact order + labels):** `Home` → `/`, `Board` → `/board`, `Recipes` → `/recipes`.
- **Active rule:** Home is active only on the exact path `/`; every other link is active when `pathname` starts with its `href`.
- **Auth:** the nav renders only on authenticated screens (Home, Board, Recipes). `/login` and `/join` must NOT render it. `/recipes` is protected automatically by `resolveAuthRoute` (deny-by-default) — **do not** add a middleware entry.
- **House style:** shadcn tokens already in use — `border-border`, `text-muted-foreground`, `bg-muted`; container width `mx-auto max-w-3xl`, page padding `p-6`. Match `app/board/page.tsx`.
- **Path alias:** `@/*` maps to repo root (e.g. `@/components/app-nav`).
- **All changes route through a PR** (branch protection on `main`). This brick's PR also carries the recipe-ingest **design spec** (`docs/superpowers/specs/2026-07-22-recipe-ingest-design.md`) into git — add it in the Task 3 commit.
- Conventional commits (`feat:`), TDD, frequent commits.

## File Structure

- `components/app-nav.tsx` — **create.** The `AppNav` client component + a pure `isActive(pathname, href)` helper (exported for direct unit testing).
- `components/app-nav.test.tsx` — **create.** Unit tests for `isActive` + rendered nav (mocked `usePathname`).
- `app/recipes/page.tsx` — **create.** Empty Recipes shell: `<AppNav/>` + heading + "coming next" copy. `dynamic = "force-dynamic"`.
- `app/recipes/page.test.tsx` — **create.** Asserts the shell renders the nav + heading.
- `app/page.tsx` — **modify.** Mount `<AppNav/>` above `main`; relax `min-h-screen` so nav + centered content coexist.
- `app/board/page.tsx` — **modify.** Mount `<AppNav/>` above `main`; remove the now-redundant inline "Home" link in the header (the nav provides it).

---

### Task 1: `AppNav` component + `isActive` helper

**Files:**
- Create: `components/app-nav.tsx`
- Test: `components/app-nav.test.tsx`

**Interfaces:**
- Produces: `export function AppNav(): JSX.Element` (client component) and `export function isActive(pathname: string, href: string): boolean`. Consumed by `app/recipes/page.tsx`, `app/page.tsx`, `app/board/page.tsx` (Tasks 2–3).

- [ ] **Step 1: Write the failing test**

```tsx
// components/app-nav.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const pathname = vi.fn(() => "/board");
vi.mock("next/navigation", () => ({ usePathname: () => pathname() }));

import { AppNav, isActive } from "./app-nav";

describe("isActive", () => {
  it("marks Home active only on the exact root", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/board", "/")).toBe(false);
  });

  it("marks a section active across its subtree", () => {
    expect(isActive("/board", "/board")).toBe(true);
    expect(isActive("/recipes/new", "/recipes")).toBe(true);
    expect(isActive("/board", "/recipes")).toBe(false);
  });
});

describe("AppNav", () => {
  it("links to Home, Board and Recipes", () => {
    pathname.mockReturnValue("/board");
    render(<AppNav />);
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: "Board" })).toHaveAttribute("href", "/board");
    expect(screen.getByRole("link", { name: "Recipes" })).toHaveAttribute("href", "/recipes");
  });

  it("marks the current section with aria-current=page", () => {
    pathname.mockReturnValue("/recipes");
    render(<AppNav />);
    expect(screen.getByRole("link", { name: "Recipes" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Board" })).not.toHaveAttribute("aria-current");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run components/app-nav.test.tsx`
Expected: FAIL — `./app-nav` does not exist.

- [ ] **Step 3: Write the component**

```tsx
// components/app-nav.tsx
"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Global navigation for the authenticated app shell (issue #12z). Rendered by
 * every signed-in screen (Home, Board, Recipes; Grocery/Dashboard later). The
 * login/join screens deliberately do NOT render it. `usePathname` marks the
 * current section — Home matches only the exact root so it isn't "active" on
 * every page.
 */

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/board", label: "Board" },
  { href: "/recipes", label: "Recipes" },
] as const;

export function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="border-border border-b">
      <div className="mx-auto flex max-w-3xl items-center gap-1 px-6 py-3">
        <span className="mr-3 text-sm font-semibold tracking-tight">
          Dinner &amp; Groceries
        </span>
        {LINKS.map((link) => {
          const active = isActive(pathname, link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              aria-current={active ? "page" : undefined}
              className={
                active
                  ? "bg-muted rounded-md px-3 py-1.5 text-sm font-medium"
                  : "text-muted-foreground rounded-md px-3 py-1.5 text-sm"
              }
            >
              {link.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run components/app-nav.test.tsx`
Expected: PASS (5 assertions across 4 tests).

- [ ] **Step 5: Commit**

```bash
git add components/app-nav.tsx components/app-nav.test.tsx
git commit -m "feat: add global AppNav component (#12z)"
```

---

### Task 2: Empty `/recipes` route

**Files:**
- Create: `app/recipes/page.tsx`
- Test: `app/recipes/page.test.tsx`

**Interfaces:**
- Consumes: `AppNav` from `@/components/app-nav` (Task 1).
- Produces: a default-exported `RecipesPage` server component serving `/recipes`.

- [ ] **Step 1: Write the failing test**

```tsx
// app/recipes/page.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/recipes" }));

import RecipesPage from "./page";

describe("RecipesPage shell", () => {
  it("renders the global nav and a Recipes heading", () => {
    render(<RecipesPage />);
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recipes" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/recipes/page.test.tsx`
Expected: FAIL — `./page` does not exist.

- [ ] **Step 3: Write the route**

```tsx
// app/recipes/page.tsx
import { AppNav } from "@/components/app-nav";

// Behind the auth/household gate (deny-by-default middleware). Session-dependent
// shell — never prerender at build time.
export const dynamic = "force-dynamic";

/**
 * Recipes screen shell (issue #12z). The fetch → edit → save ingest flow is #12c;
 * the library list is #12d. For now this is the empty destination the global nav
 * points at, so the shell + navigation ship and are reviewed on their own.
 */
export default function RecipesPage() {
  return (
    <>
      <AppNav />
      <main className="mx-auto max-w-3xl space-y-4 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Recipes</h1>
        <p className="text-muted-foreground text-sm">
          Add a recipe by pasting a link or entering it by hand — coming next.
        </p>
      </main>
    </>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/recipes/page.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/recipes/page.tsx app/recipes/page.test.tsx
git commit -m "feat: add empty /recipes route behind the app shell (#12z)"
```

---

### Task 3: Mount the nav on Home + Board; drop the redundant Home link; carry the spec into git

**Files:**
- Modify: `app/page.tsx` — mount `<AppNav/>`, relax `min-h-screen`.
- Modify: `app/board/page.tsx` — mount `<AppNav/>`, remove the inline "Home" link.
- Add to git (no code change): `docs/superpowers/specs/2026-07-22-recipe-ingest-design.md`.

**Interfaces:**
- Consumes: `AppNav` from `@/components/app-nav` (Task 1).

**Context for the implementer:** neither `app/page.tsx` nor `app/board/page.tsx` has a unit test (they are server components doing data fetches), and the Playwright E2E navigates via `page.goto(...)`, not by clicking the board's "Home" link — so removing that link breaks no test. Verify with the grep in Step 3.

- [ ] **Step 1: Mount `AppNav` on Home (`app/page.tsx`)**

Add the import near the other imports:

```tsx
import { AppNav } from "@/components/app-nav";
```

Wrap the returned `main` so the nav sits above it, and relax the full-height centering so the nav is visible. Replace the `return (` block's outer element:

```tsx
  return (
    <>
      <AppNav />
      <main className="flex min-h-[80vh] flex-col items-center justify-center gap-6 p-8 text-center">
        {/* ...unchanged existing children (heading, welcome copy, "Plan this
            week" link, InvitePanel, sign-out form)... */}
      </main>
    </>
  );
```

Keep every existing child of `main` exactly as-is — only the wrapper (`<>…</>`), the added `<AppNav/>`, and `min-h-screen` → `min-h-[80vh]` change.

- [ ] **Step 2: Mount `AppNav` on Board + remove the inline Home link (`app/board/page.tsx`)**

Add the import near the other imports:

```tsx
import { AppNav } from "@/components/app-nav";
```

Wrap the returned `main` with the nav, and simplify the header. The current header opens with a flex row holding the `<h1>` and a `<Link href="/">Home</Link>`; replace that row with just the heading (the global nav now provides Home). Concretely:

- Change the outer `return ( <main …>` to `return ( <> <AppNav /> <main …>` and close with `</main> </>`.
- Inside `<header className="space-y-3">`, replace this block:

```tsx
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            Weekly menu
          </h1>
          <Link
            href="/"
            className="text-muted-foreground text-sm underline underline-offset-4"
          >
            Home
          </Link>
        </div>
```

with just:

```tsx
        <h1 className="text-2xl font-semibold tracking-tight">Weekly menu</h1>
```

Leave the `<nav aria-label="Week navigation">` week switcher and everything below it untouched. (`Link` is still used by the week switcher, so keep its import.)

- [ ] **Step 3: Verify the whole unit suite + typecheck + lint are green, and no test relied on the removed link**

Run: `grep -rn "name: .Home." app e2e components 2>/dev/null` — expect no test asserting a "Home" link on the board (the global nav's Home link, asserted in `components/app-nav.test.tsx`, is fine).
Run: `npx vitest run`
Expected: PASS (all suites, including the two new ones).
Run: `npm run lint && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Manually sanity-check the shell renders (optional, dev server)**

If a local Supabase + dev server is running (`npm run db:start` then `npm run dev`), load `/board` and `/recipes` and confirm the nav bar shows Home/Board/Recipes with the current section highlighted. Skip if no local stack — the unit tests cover the contract.

- [ ] **Step 5: Commit (code + spec)**

```bash
git add app/page.tsx app/board/page.tsx docs/superpowers/specs/2026-07-22-recipe-ingest-design.md
git commit -m "feat: mount global nav on home + board; land recipe-ingest design spec (#12z)"
```

---

## Self-Review

**1. Spec coverage (12z section):** ✅ global nav with Board/Recipes (+Home) links → Task 1; empty `/recipes` route → Task 2; signed-in-only (login/join excluded, `/recipes` auto-protected) → covered by rendering the nav only on authed screens + deny-by-default routing (no middleware change); YAGNI (no framework) → plain links, `isActive` only; follows layout conventions → `max-w-3xl`, shadcn tokens; component test → Tasks 1–2 tests.

**2. Placeholder scan:** none — every step has concrete code or exact commands.

**3. Type consistency:** `AppNav` / `isActive` signatures defined in Task 1 are consumed unchanged in Tasks 2–3. `usePathname` mock shape (`() => string`) is consistent across `app-nav.test.tsx` and `recipes/page.test.tsx`.
