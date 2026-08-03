import Link from "next/link";

import { AppNav } from "@/components/app-nav";
import { createServerComponentClient } from "@/lib/supabase/server-component";
import {
  addWeeks,
  currentWeekStart,
  isValidIsoDate,
  weekStartForDate,
} from "@/lib/week/boundary";
import { formatWeekRange } from "@/lib/week/labels";

import { getOrCreateWeek } from "./actions-core";
import { BoardGrid, type SlottedDishView } from "./board-grid";
import {
  ProposalPool,
  type CommentRow,
  type ProposalView,
  type ReactionRow,
} from "./proposal-pool";
import { ProposeForm, type LibraryDish } from "./propose-form";

// Per-user, session-dependent (and it lazily writes the week row): never
// prerender at build time.
export const dynamic = "force-dynamic";

/**
 * The weekly menu board (issue #8). The middleware guarantees a signed-in member
 * reaches here, so every query runs through the RLS-scoped cookie session.
 *
 * Flow:
 *   1. Resolve the household's timezone + week-start preference (ADR 0003).
 *   2. Determine the viewed week: a validated `?week=` param (normalized to the
 *      household's canonical boundary) or, by default, the current local week.
 *   3. Lazily UPSERT the week row (idempotent on UNIQUE(household_id, start_date)
 *      — reopening never duplicates).
 *   4. Render the day x meal-type grid, the week's proposal pool, and the
 *      propose / propose-again forms. Past + future weeks are reachable and
 *      editable (no lock).
 */
export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const supabase = await createServerComponentClient();
  const { week: weekParam } = await searchParams;

  // 0) The verified session user — used to resolve the current member id (which
  //    reaction is "mine") and to attribute comments. Never trusted from input.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // 1) Household week settings (RLS scopes this to the caller's household).
  const { data: household } = await supabase
    .from("households")
    .select("name, timezone, week_start_day")
    .maybeSingle();

  const timezone = household?.timezone ?? "America/Los_Angeles";
  const weekStartDay = household?.week_start_day ?? 1;

  // 2) Viewed week: validated param (normalized) or the current local week.
  const weekStart =
    weekParam && isValidIsoDate(weekParam)
      ? weekStartForDate(weekParam, weekStartDay)
      : currentWeekStart(new Date(), timezone, weekStartDay);

  // 3) Lazy, idempotent week creation. The denormalized household_id NOT NULL
  //    column is checked by the INSERT policy, so resolve it from the session's
  //    SECURITY DEFINER helper (never from input) before upserting.
  const { data: householdId } = await supabase.rpc("current_household_id");
  const week = householdId
    ? await getOrCreateWeek(supabase, { householdId, startDate: weekStart })
    : null;

  const weekId = week?.ok ? week.weekId : null;

  // 4) The week's proposal pool (+ dish + proposer) and the recyclable library.
  let proposals: ProposalView[] = [];
  if (weekId) {
    const { data } = await supabase
      .from("proposals")
      .select(
        "id, dish_id, created_at, note, dish:dishes(title, source_url), proposer:members(display_name)",
      )
      .eq("week_id", weekId)
      .order("created_at", { ascending: true });

    proposals = (data ?? []).map((row) => {
      const dish = row.dish as { title: string; source_url: string | null } | null;
      const proposer = row.proposer as { display_name: string } | null;
      return {
        id: row.id,
        dishId: row.dish_id,
        createdAt: row.created_at,
        title: dish?.title ?? "Untitled dish",
        note: row.note,
        sourceUrl: dish?.source_url ?? null,
        proposerName: proposer?.display_name ?? null,
      };
    });
  }

  // The week's slotted dishes (issue #10): every slot_dishes row in this week's
  // slots, with its day+meal target and dish title. RLS scopes both tables to the
  // household. Rendered into the grid cells (with tap-to-unslot).
  let slotted: SlottedDishView[] = [];
  if (weekId) {
    const { data: slotRows } = await supabase
      .from("slots")
      .select("day_of_week, meal_type, slot_dishes(id, dish_id, dish:dishes(title))")
      .eq("week_id", weekId);

    slotted = (slotRows ?? []).flatMap((slot) => {
      const rows =
        (slot.slot_dishes as
          | { id: string; dish_id: string; dish: { title: string } | null }[]
          | null) ?? [];
      return rows.map((sd) => ({
        slotDishId: sd.id,
        dishId: sd.dish_id,
        title: sd.dish?.title ?? "Untitled dish",
        dayOfWeek: slot.day_of_week,
        mealType: slot.meal_type,
      }));
    });
  }

  const { data: libraryRows } = await supabase
    .from("dishes")
    .select("id, title")
    .order("title", { ascending: true });
  const libraryDishes: LibraryDish[] = libraryRows ?? [];

  // 5) The week's social signals (issue #9): reactions + comments for the pool's
  //    proposals, plus the member id->name map for attribution. All RLS-scoped.
  //    This server fetch is the correctness baseline — the board works fully
  //    without Realtime; Realtime only pushes subsequent changes live.
  const { data: memberRows } = await supabase
    .from("members")
    .select("id, display_name, user_id");
  const members = memberRows ?? [];
  const currentMemberId =
    members.find((m) => m.user_id === user?.id)?.id ?? "";
  const memberNames: Record<string, string> = Object.fromEntries(
    members.map((m) => [m.id, m.display_name]),
  );

  let reactions: ReactionRow[] = [];
  let comments: CommentRow[] = [];
  if (proposals.length > 0) {
    const proposalIds = proposals.map((p) => p.id);
    const { data: reactionRows } = await supabase
      .from("reactions")
      .select("id, proposal_id, member_id, kind")
      .in("proposal_id", proposalIds);
    reactions = reactionRows ?? [];

    const { data: commentRows } = await supabase
      .from("comments")
      .select("id, proposal_id, member_id, body, created_at")
      .in("proposal_id", proposalIds)
      .order("created_at", { ascending: true });
    comments = commentRows ?? [];
  }

  const prevWeek = addWeeks(weekStart, -1);
  const nextWeek = addWeeks(weekStart, 1);
  const thisWeek = currentWeekStart(new Date(), timezone, weekStartDay);
  const isCurrent = weekStart === thisWeek;

  return (
    <>
      <AppNav />
      <main className="mx-auto max-w-3xl space-y-8 p-6">
        <header className="space-y-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            Weekly menu
          </h1>

          <nav
            aria-label="Week navigation"
            className="flex items-center justify-between gap-2"
          >
            <Link
              href={`/board?week=${prevWeek}`}
              className="border-input rounded-md border px-3 py-1.5 text-sm"
              rel="prev"
            >
              ← Previous
            </Link>

            <div className="text-center">
              <span className="block text-sm font-medium">
                {formatWeekRange(weekStart)}
              </span>
              {isCurrent ? (
                <span className="text-muted-foreground text-xs">
                  This week
                </span>
              ) : (
                <Link
                  href={`/board?week=${thisWeek}`}
                  className="text-primary text-xs underline underline-offset-4"
                >
                  Jump to this week
                </Link>
              )}
            </div>

            <Link
              href={`/board?week=${nextWeek}`}
              className="border-input rounded-md border px-3 py-1.5 text-sm"
              rel="next"
            >
              Next →
            </Link>
          </nav>
        </header>

        {weekId ? (
          <>
            <BoardGrid
              weekStart={weekStart}
              weekStartDay={weekStartDay}
              slotted={slotted}
            />
            <ProposalPool
              householdId={householdId ?? ""}
              currentMemberId={currentMemberId}
              weekStart={weekStart}
              weekStartDay={weekStartDay}
              proposals={proposals}
              initialReactions={reactions}
              initialComments={comments}
              memberNames={memberNames}
            />
            <section className="border-border space-y-4 rounded-lg border p-4">
              <ProposeForm weekStart={weekStart} libraryDishes={libraryDishes} />
            </section>
          </>
        ) : (
          <p className="text-destructive text-sm">
            We couldn&apos;t open this week. Please reload.
          </p>
        )}
      </main>
    </>
  );
}
