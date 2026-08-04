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
