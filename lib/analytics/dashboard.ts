/**
 * The PO dashboard's aggregation (issue #17, slice 1e; ADR 0014). Turns the
 * append-only `events` log into the three panels `/dashboard` renders:
 * adoption, per-member participation, and trips.
 *
 * Framework-free with an INJECTED client, like `app/grocery/list-core.ts`: the
 * pure `summarizeDashboard` holds every counting rule (unit-tested exhaustively),
 * and `loadDashboardSummary` is the thin read that feeds it. The Server
 * Component supplies the RLS-scoped cookie-session client, so this module never
 * filters by household — RLS does, and since #17's migration RLS also requires
 * the caller to be the household OWNER (ADR 0003, ADR 0014 §3).
 *
 * Rules of record:
 *   - **Fixed 30-day window, no date picker** (ADR 0014; rich trends are
 *     post-MVP). An event exactly on the boundary is in; one microsecond older
 *     is out. Future-stamped and unparseable timestamps are ignored rather than
 *     counted — a skewed clock is not participation.
 *   - **Adoption** = active DAYS per member from `session_start` / `sign_in`,
 *     plus DAU/WAU as DISTINCT MEMBERS. Days are UTC calendar days: the
 *     household's timezone lives on `households`, but reading it here would
 *     make the dashboard's own numbers depend on a second table for a figure
 *     that is only ever read as a trend. Stated so nobody debugs it as an
 *     off-by-one.
 *   - **Unattributed usage events** (`member_id is null` — a `sign_in` before a
 *     household exists, or a removed member's surviving rows) are counted in
 *     the totals and attributed to NOBODY. Same for a `member_id` that is no
 *     longer on the roster.
 *   - **Participation** = `proposal_created`, `reaction_added`, `comment_added`,
 *     `slot_filled` per member. EVERY member appears, including one who has done
 *     nothing (zeroes): an absent row is indistinguishable from a bug, and a
 *     missing kid is the last thing this screen should make Jon wonder about.
 *     Ordered ALPHABETICALLY, never by volume — this is not a leaderboard
 *     (north star: low-key and judgment-free, never a kid-facing scorecard).
 *   - **Trips** = `trip_completed` only, with `grocery_list_built` alongside.
 *     "We have it" emits no event and is not a trip (ADR 0012).
 *   - **Empty is said out loud.** Each panel carries `hasActivity`, so the page
 *     can render "no activity yet" instead of a zero-filled panel that reads
 *     like a breakage.
 *   - `recipe_ingested` and `screen_view` have no panel, so they are not even
 *     read (ADR 0014 §2).
 *
 * Privacy: the only join is `members` for DISPLAY NAMES. No roles, no emails,
 * no `user_id`, no per-child health data, and no new data source (ADR 0004 —
 * events-table-only; #17's hard boundary).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/database.types";

import type { EventType } from "./events";

type DbClient = SupabaseClient<Database>;

/** The fixed window, in days (ADR 0014 — deliberately not configurable). */
export const WINDOW_DAYS = 30;

/** The trailing window used for the "this week" active count. */
const WEEK_DAYS = 7;

const MS_PER_DAY = 86_400_000;

/** Usage events behind the adoption panel. */
const USAGE_TYPES = ["session_start", "sign_in"] as const;

/** Participation events, in the order the table renders them. */
const PARTICIPATION_TYPES = [
  "proposal_created",
  "reaction_added",
  "comment_added",
  "slot_filled",
] as const;

/** Grocery-side events behind the trips panel. */
const TRIP_TYPES = ["trip_completed", "grocery_list_built"] as const;

/**
 * Every event type a panel reads — and nothing else, so the query fetches only
 * what it renders. `recipe_ingested` (no panel) and `screen_view` (never
 * emitted, ADR 0014 §2) are deliberately absent.
 */
export const DASHBOARD_EVENT_TYPES = [
  ...USAGE_TYPES,
  ...PARTICIPATION_TYPES,
  ...TRIP_TYPES,
] as const satisfies readonly EventType[];

/** One event row, in camelCase. */
export type DashboardEvent = {
  eventType: EventType;
  /** null ⇒ unattributed usage (pre-membership `sign_in`, removed member). */
  memberId: string | null;
  /** ISO timestamp, as stored. */
  createdAt: string;
};

/** A household member — display name only. */
export type DashboardMember = { id: string; displayName: string };

export type MemberAdoption = {
  memberId: string;
  displayName: string;
  /** Distinct UTC days with a `session_start` / `sign_in` in the window. */
  activeDays: number;
};

export type MemberParticipation = {
  memberId: string;
  displayName: string;
  proposalsCreated: number;
  reactionsAdded: number;
  commentsAdded: number;
  slotsFilled: number;
  /** Sum of the four counts above. */
  total: number;
};

export type AdoptionPanel = {
  /** false ⇒ render "no activity yet", not a row of zeroes. */
  hasActivity: boolean;
  byMember: MemberAdoption[];
  /** Distinct members with a usage event today (UTC). */
  activeToday: number;
  /** Distinct members with a usage event in the last 7 days. */
  activeThisWeek: number;
  usageEvents: number;
  /** Usage events that belong to nobody on the roster. */
  unattributedUsageEvents: number;
};

export type ParticipationPanel = {
  hasActivity: boolean;
  byMember: MemberParticipation[];
  /** Every participation event in the window, roster or not. */
  total: number;
};

export type TripsPanel = {
  completed: number;
  listsBuilt: number;
  hasActivity: boolean;
};

export type DashboardSummary = {
  window: { start: string; end: string; days: number };
  adoption: AdoptionPanel;
  participation: ParticipationPanel;
  trips: TripsPanel;
};

/** The UTC calendar day an instant falls in ("2026-09-15"). */
function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** Start of the fixed window for a given "now". */
export function windowStart(now: Date): Date {
  return new Date(now.getTime() - WINDOW_DAYS * MS_PER_DAY);
}

/**
 * Aggregate the window's events into the three panels. Pure: every counting
 * rule lives here, so the numbers Jon reads are unit-tested without a DB.
 *
 * `events` may contain anything — the in-window filter is applied HERE as well
 * as in the query, so the rules hold no matter what the caller passes.
 */
export function summarizeDashboard(
  events: DashboardEvent[],
  members: DashboardMember[],
  { now }: { now: Date },
): DashboardSummary {
  const start = windowStart(now);
  const today = dayKey(now);
  const weekStart = new Date(now.getTime() - WEEK_DAYS * MS_PER_DAY);

  const roster = new Map(members.map((m) => [m.id, m.displayName]));
  const ordered = [...members].sort(
    (a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id),
  );

  // Per-member accumulators, pre-seeded for EVERY member so a member who has
  // done nothing still renders (with zeroes).
  const activeDays = new Map<string, Set<string>>();
  const participation = new Map<string, MemberParticipation>();
  for (const m of ordered) {
    activeDays.set(m.id, new Set());
    participation.set(m.id, {
      memberId: m.id,
      displayName: m.displayName,
      proposalsCreated: 0,
      reactionsAdded: 0,
      commentsAdded: 0,
      slotsFilled: 0,
      total: 0,
    });
  }

  let usageEvents = 0;
  let unattributedUsageEvents = 0;
  let participationTotal = 0;
  let completed = 0;
  let listsBuilt = 0;
  const todayMembers = new Set<string>();
  const weekMembers = new Set<string>();

  for (const event of events) {
    const at = new Date(event.createdAt);
    // Unparseable, older than the window, or in the future: not counted.
    if (Number.isNaN(at.getTime())) continue;
    if (at < start || at > now) continue;

    // A member_id that is not on the roster counts toward the totals but is
    // attributed to nobody (same as a null).
    const attributed = event.memberId !== null && roster.has(event.memberId);

    switch (event.eventType) {
      case "session_start":
      case "sign_in": {
        usageEvents += 1;
        if (!attributed) {
          unattributedUsageEvents += 1;
          break;
        }
        const memberId = event.memberId!;
        activeDays.get(memberId)!.add(dayKey(at));
        if (dayKey(at) === today) todayMembers.add(memberId);
        if (at >= weekStart) weekMembers.add(memberId);
        break;
      }
      case "proposal_created":
      case "reaction_added":
      case "comment_added":
      case "slot_filled": {
        participationTotal += 1;
        if (!attributed) break;
        const row = participation.get(event.memberId!)!;
        if (event.eventType === "proposal_created") row.proposalsCreated += 1;
        else if (event.eventType === "reaction_added") row.reactionsAdded += 1;
        else if (event.eventType === "comment_added") row.commentsAdded += 1;
        else row.slotsFilled += 1;
        row.total += 1;
        break;
      }
      case "trip_completed":
        completed += 1;
        break;
      case "grocery_list_built":
        listsBuilt += 1;
        break;
      default:
        // `recipe_ingested` / `screen_view`: no panel reads them (ADR 0014 §2).
        break;
    }
  }

  return {
    window: { start: start.toISOString(), end: now.toISOString(), days: WINDOW_DAYS },
    adoption: {
      hasActivity: usageEvents > 0,
      byMember: ordered.map((m) => ({
        memberId: m.id,
        displayName: m.displayName,
        activeDays: activeDays.get(m.id)!.size,
      })),
      activeToday: todayMembers.size,
      activeThisWeek: weekMembers.size,
      usageEvents,
      unattributedUsageEvents,
    },
    participation: {
      hasActivity: participationTotal > 0,
      byMember: ordered.map((m) => participation.get(m.id)!),
      total: participationTotal,
    },
    trips: {
      completed,
      listsBuilt,
      hasActivity: completed > 0 || listsBuilt > 0,
    },
  };
}

type EventRow = {
  event_type: EventType;
  member_id: string | null;
  created_at: string;
};

type MemberRow = { id: string; display_name: string };

/**
 * Read the window's events plus the roster's display names, then summarize.
 *
 * Security: no `household_id` filter and no service-role key — RLS scopes the
 * read to the caller's household AND (since #17) to the household owner. The
 * route's 404 for a non-owner is the UX; this read would return nothing for one
 * anyway.
 *
 * Degradation: a failed read yields an empty summary rather than throwing, so
 * the page renders its explicit empty states instead of a 500.
 */
export async function loadDashboardSummary(
  supabase: Pick<DbClient, "from">,
  { now = new Date() }: { now?: Date } = {},
): Promise<DashboardSummary> {
  const [{ data: eventRows }, { data: memberRows }] = await Promise.all([
    supabase
      .from("events")
      .select("event_type, member_id, created_at")
      .gte("created_at", windowStart(now).toISOString())
      .in("event_type", [...DASHBOARD_EVENT_TYPES]),
    supabase.from("members").select("id, display_name"),
  ]);

  const events = ((eventRows ?? []) as unknown as EventRow[]).map((row) => ({
    eventType: row.event_type,
    memberId: row.member_id,
    createdAt: row.created_at,
  }));
  const members = ((memberRows ?? []) as unknown as MemberRow[]).map((row) => ({
    id: row.id,
    displayName: row.display_name,
  }));

  return summarizeDashboard(events, members, { now });
}
