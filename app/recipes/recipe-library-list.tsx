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
