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
