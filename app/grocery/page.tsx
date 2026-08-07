import { AppNav } from "@/components/app-nav";
import { createServerComponentClient } from "@/lib/supabase/server-component";
import { currentWeekStart } from "@/lib/week/boundary";
import { formatWeekRange } from "@/lib/week/labels";
import { getOrCreateWeek, loadWeekSettings } from "@/lib/week/open-week";

import { resolveGroceryActor } from "./actor";
import { GroceryList } from "./grocery-list";
import { loadGroceryList } from "./list-core";

// Per-user, session-dependent (and it lazily writes the week row): never
// prerender at build time.
export const dynamic = "force-dynamic";

/**
 * The week's shopping list (issue #15, slice 1d). The middleware guarantees a
 * signed-in member reaches here, so every query runs through the RLS-scoped
 * cookie session — no service-role key, no manual household filter.
 *
 * Flow (mirrors `app/board/page.tsx`, sharing its week resolution so the two
 * screens can never land on different weeks):
 *   1. Resolve the caller's household from the VERIFIED session.
 *   2. Resolve the CURRENT week in the household's timezone + week-start
 *      preference and lazily UPSERT its row (idempotent).
 *   3. Read the active list + the staples catalog.
 *   4. Hand them to the live client list.
 *
 * The list is deliberately "this week" only — a shopper standing in the store
 * wants today's list, not week navigation (that's the board's job).
 */
export default async function GroceryPage() {
  const supabase = await createServerComponentClient();

  // Household + member from the session, never from input.
  const actor = await resolveGroceryActor(supabase);

  const { timezone, weekStartDay } = await loadWeekSettings(supabase);
  const weekStart = currentWeekStart(new Date(), timezone, weekStartDay);

  const week = actor
    ? await getOrCreateWeek(supabase, {
        householdId: actor.householdId,
        startDate: weekStart,
      })
    : null;
  const weekId = week?.ok ? week.weekId : null;

  const { items, catalog } = weekId
    ? await loadGroceryList(supabase, { weekId })
    : { items: [], catalog: [] };

  return (
    <>
      <AppNav />
      <main className="mx-auto max-w-3xl space-y-6 p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Groceries</h1>
          <p className="text-muted-foreground text-sm">
            {formatWeekRange(weekStart)}
          </p>
        </header>

        {weekId && actor ? (
          <GroceryList
            weekId={weekId}
            householdId={actor.householdId}
            initialItems={items}
            catalog={catalog}
          />
        ) : (
          <p className="text-destructive text-sm">
            We couldn&apos;t open this week&apos;s list. Please reload.
          </p>
        )}
      </main>
    </>
  );
}
