import { notFound } from "next/navigation";

import { AppNav } from "@/components/app-nav";
import { createServerComponentClient } from "@/lib/supabase/server-component";

import { loadRecipeDetail } from "./detail-core";
import { IngredientGroups } from "./ingredient-groups";
import { RecipeMethod } from "./method";
import { RecipeMeta } from "./recipe-meta";

// Behind the auth/household gate (deny-by-default middleware). Session-dependent
// + RLS-scoped read — never prerender at build time.
export const dynamic = "force-dynamic";

/**
 * Read-only recipe detail page (issue #12c, kickoff resolution 3) — the PRG
 * redirect target after a save, and 12d's library-list link target. Mirrors
 * `app/board/page.tsx`: an async Server Component whose queries all run through
 * the RLS-scoped cookie session. A miss (bad id or another household's recipe)
 * renders the not-found boundary, never a crash and never a cross-household
 * read. Untrusted text (title, ingredient lines, method) renders as plain React
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

        <RecipeMeta
          prepMinutes={recipe.prepMinutes}
          cookMinutes={recipe.cookMinutes}
          totalMinutes={recipe.totalMinutes}
          servings={recipe.servings}
        />

        <details className="space-y-2 rounded-lg border p-3" open={!recipe.method}>
          <summary className="cursor-pointer font-medium">
            {recipe.method ? "All ingredients (for shopping)" : "Ingredients"}
          </summary>
          <IngredientGroups groups={recipe.ingredientGroups} />
        </details>

        {recipe.method ? (
          <RecipeMethod phases={recipe.method.phases} dishId={recipe.id} />
        ) : null}

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
