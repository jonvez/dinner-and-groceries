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
