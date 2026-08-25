import { AppNav } from "@/components/app-nav";
import { createServerComponentClient } from "@/lib/supabase/server-component";
import { currentWeekStart } from "@/lib/week/boundary";
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
 *   3. Read the active list, the staples catalog, and the household's aisles.
 *   4. Hand them to the live client list.
 *
 * The list is a ROLLING list, not a weekly one. It shows everything the
 * household still has to buy, whenever it was added; an item leaves only when
 * someone buys it (complete trip) or removes it. Scoping the read to the
 * current week is what made a whole week's additions vanish at the Monday
 * boundary — the rows were intact, merely unreachable, which to the family is
 * indistinguishable from losing them.
 *
 * The week is still resolved here, because it is still needed: new rows record
 * the week they were created in, and "rebuild from menu" syncs against THIS
 * week's slotted dishes. It just no longer decides what the list shows.
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

  // The read needs no week; the GATE is still `weekId`, because without a week
  // row the client cannot add anything and the error state below is correct.
  const { items, catalog, sections } = weekId
    ? await loadGroceryList(supabase)
    : { items: [], catalog: [], sections: [] };

  return (
    <>
      <AppNav />
      <main className="mx-auto max-w-3xl space-y-6 p-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Groceries</h1>
          <p className="text-muted-foreground text-sm">
            Everything you still need to buy
          </p>
        </header>

        {weekId && actor ? (
          <GroceryList
            weekId={weekId}
            householdId={actor.householdId}
            initialItems={items}
            catalog={catalog}
            sections={sections}
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
