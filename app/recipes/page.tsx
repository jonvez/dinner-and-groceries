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
