import { describe, expect, it, vi } from "vitest";

import {
  DASHBOARD_EVENT_TYPES,
  loadDashboardSummary,
  summarizeDashboard,
  WINDOW_DAYS,
  type DashboardEvent,
  type DashboardMember,
} from "./dashboard";

/**
 * The PO dashboard's aggregation (issue #17, ADR 0014). Pure + injected-client,
 * like `lib/grocery/rollup.ts` and `app/grocery/list-core.ts`, so the numbers
 * Jon reads are pinned without a live DB.
 *
 * What's pinned here:
 *   - the FIXED 30-day window and its boundaries (no date picker — ADR 0014);
 *   - per-member participation counts, INCLUDING a member who has done nothing:
 *     they appear with zeroes, because an absent row is indistinguishable from
 *     a bug (and a missing kid is exactly the wrong thing to make Jon wonder
 *     about);
 *   - adoption = active DAYS per member from `session_start`/`sign_in`, plus
 *     DAU/WAU, with unattributed (`member_id is null`) usage events counted in
 *     the totals but attributable to nobody;
 *   - trips come from `trip_completed` ONLY — "we have it" is not a trip
 *     (ADR 0012);
 *   - an empty dataset yields explicit `hasActivity: false` flags, never a
 *     zero-filled panel that reads like a breakage;
 *   - the read asks for only the event types a panel renders (no
 *     `recipe_ingested`, no `screen_view`) and degrades to empty on a failure.
 */

const NOW = new Date("2026-09-15T12:00:00.000Z");

/** `days` before NOW (+ optional hours), as an ISO timestamp. */
function ago(days: number, hours = 0): string {
  return new Date(NOW.getTime() - days * 86_400_000 - hours * 3_600_000).toISOString();
}

const MEMBERS: DashboardMember[] = [
  { id: "m-jon", displayName: "Jon" },
  { id: "m-jojo", displayName: "Jojo" },
  { id: "m-kai", displayName: "Kai" },
];

const ev = (
  eventType: DashboardEvent["eventType"],
  memberId: string | null,
  createdAt: string,
): DashboardEvent => ({ eventType, memberId, createdAt });

describe("summarizeDashboard — the window", () => {
  it("is a fixed 30 days ending now", () => {
    expect(WINDOW_DAYS).toBe(30);
    const { window } = summarizeDashboard([], MEMBERS, { now: NOW });
    expect(window.days).toBe(30);
    expect(window.end).toBe(NOW.toISOString());
    expect(window.start).toBe("2026-08-16T12:00:00.000Z");
  });

  it("includes an event exactly on the 30-day boundary and excludes one older", () => {
    const events = [
      ev("trip_completed", "m-jon", ago(30)),
      ev("trip_completed", "m-jon", new Date(NOW.getTime() - 30 * 86_400_000 - 1).toISOString()),
    ];
    expect(summarizeDashboard(events, MEMBERS, { now: NOW }).trips.completed).toBe(1);
  });

  it("ignores an event stamped in the future (clock skew is not participation)", () => {
    const future = new Date(NOW.getTime() + 60_000).toISOString();
    const summary = summarizeDashboard([ev("trip_completed", "m-jon", future)], MEMBERS, {
      now: NOW,
    });
    expect(summary.trips.completed).toBe(0);
  });

  it("ignores an unparseable timestamp rather than counting it", () => {
    const summary = summarizeDashboard([ev("trip_completed", "m-jon", "not-a-date")], MEMBERS, {
      now: NOW,
    });
    expect(summary.trips.completed).toBe(0);
  });
});

describe("summarizeDashboard — adoption", () => {
  it("counts active DAYS per member, not events per member", () => {
    const events = [
      ev("session_start", "m-jojo", ago(1, 1)),
      ev("session_start", "m-jojo", ago(1, 2)), // same UTC day
      ev("sign_in", "m-jojo", ago(3)),
      ev("session_start", "m-jon", ago(2)),
    ];
    const { adoption } = summarizeDashboard(events, MEMBERS, { now: NOW });
    expect(adoption.byMember).toEqual([
      { memberId: "m-jojo", displayName: "Jojo", activeDays: 2 },
      { memberId: "m-jon", displayName: "Jon", activeDays: 1 },
      { memberId: "m-kai", displayName: "Kai", activeDays: 0 },
    ]);
    expect(adoption.usageEvents).toBe(4);
    expect(adoption.hasActivity).toBe(true);
  });

  it("reports DAU and WAU as distinct members, not event counts", () => {
    const events = [
      ev("session_start", "m-jon", ago(0, 1)), // today
      ev("session_start", "m-jon", ago(0, 2)), // today again — same member
      ev("session_start", "m-jojo", ago(3)), // this week
      ev("sign_in", "m-kai", ago(20)), // in the window, not the week
    ];
    const { adoption } = summarizeDashboard(events, MEMBERS, { now: NOW });
    expect(adoption.activeLast24h).toBe(1);
    expect(adoption.activeThisWeek).toBe(2);
  });

  it("counts an unattributed usage event in the total but for no member", () => {
    // `sign_in` can fire before a membership exists (ADR 0014), and a removed
    // member's events survive with member_id nulled: real usage, nobody to
    // attribute it to. It must not vanish, and must not be invented onto a row.
    const { adoption } = summarizeDashboard([ev("sign_in", null, ago(1))], MEMBERS, {
      now: NOW,
    });
    expect(adoption.usageEvents).toBe(1);
    expect(adoption.unattributedUsageEvents).toBe(1);
    expect(adoption.activeThisWeek).toBe(0);
    expect(adoption.byMember.every((m) => m.activeDays === 0)).toBe(true);
    expect(adoption.hasActivity).toBe(true);
  });

  it("attributes nothing to a member_id that is not in the household roster", () => {
    const { adoption, participation } = summarizeDashboard(
      [ev("session_start", "m-ghost", ago(1)), ev("proposal_created", "m-ghost", ago(1))],
      MEMBERS,
      { now: NOW },
    );
    expect(adoption.byMember.map((m) => m.memberId)).toEqual(["m-jojo", "m-jon", "m-kai"]);
    expect(adoption.usageEvents).toBe(1);
    expect(participation.total).toBe(1);
    expect(participation.byMember.every((m) => m.total === 0)).toBe(true);
  });

  it("says so explicitly when nobody has used the app", () => {
    const { adoption } = summarizeDashboard(
      [ev("trip_completed", "m-jon", ago(1))],
      MEMBERS,
      { now: NOW },
    );
    expect(adoption.hasActivity).toBe(false);
    expect(adoption.usageEvents).toBe(0);
  });
});

/**
 * The headline is a ROLLING 24 HOURS, not a UTC calendar day (#228).
 *
 * It used to bucket by UTC day and compare against `dayKey(now)`. For a Pacific
 * household the UTC day rolls over at 17:00 local, so from 5pm onwards the
 * figure read 0 even while the family was actively using the app that
 * afternoon — wrong at exactly the hour a parent is most likely to look.
 *
 * A rolling window is timezone-independent, needs no read of
 * `households.timezone`, and cannot read 0 during the family's own afternoon.
 * The per-member `activeDays` counts stay UTC calendar days: those are a trend,
 * where a fixed bucket is fine.
 */
describe("summarizeDashboard — the headline is a rolling 24 hours (#228)", () => {
  it("counts an event from 2 hours ago", () => {
    const { adoption } = summarizeDashboard([ev("session_start", "m-jojo", ago(0, 2))], MEMBERS, {
      now: NOW,
    });
    expect(adoption.activeLast24h).toBe(1);
  });

  it("does NOT count an event from 25 hours ago", () => {
    const { adoption } = summarizeDashboard([ev("session_start", "m-jojo", ago(0, 25))], MEMBERS, {
      now: NOW,
    });
    expect(adoption.activeLast24h).toBe(0);
    // Still real usage, just not in the last 24h.
    expect(adoption.activeThisWeek).toBe(1);
  });

  it("counts the family's own afternoon after the UTC day has rolled over", () => {
    // The #228 repro. Jojo opens the app at 10:00 America/Los_Angeles, which is
    // 17:00Z — already "tomorrow" in UTC terms by the time Jon looks at 20:00
    // Pacific (03:00Z the next day). Ten hours earlier the SAME local day, and
    // the old UTC-day bucket reported it as nobody.
    const morningPacific = "2026-09-15T17:00:00.000Z";
    const eveningPacific = new Date("2026-09-16T03:00:00.000Z");
    const { adoption } = summarizeDashboard(
      [ev("session_start", "m-jojo", morningPacific)],
      MEMBERS,
      { now: eveningPacific },
    );
    expect(adoption.activeLast24h).toBe(1);
    expect(adoption.activeThisWeek).toBe(1);
  });

  it("includes an event exactly 24 hours old and excludes one a millisecond older", () => {
    // Closed at the boundary, like the 30-day window and the 7-day one.
    const exactly = new Date(NOW.getTime() - 86_400_000).toISOString();
    const older = new Date(NOW.getTime() - 86_400_000 - 1).toISOString();
    expect(
      summarizeDashboard([ev("session_start", "m-jojo", exactly)], MEMBERS, { now: NOW }).adoption
        .activeLast24h,
    ).toBe(1);
    expect(
      summarizeDashboard([ev("session_start", "m-jojo", older)], MEMBERS, { now: NOW }).adoption
        .activeLast24h,
    ).toBe(0);
  });

  it("counts DISTINCT MEMBERS in the window, not events", () => {
    const events = [
      ev("session_start", "m-jojo", ago(0, 1)),
      ev("session_start", "m-jojo", ago(0, 3)),
      ev("sign_in", "m-jon", ago(0, 5)),
    ];
    expect(summarizeDashboard(events, MEMBERS, { now: NOW }).adoption.activeLast24h).toBe(2);
  });

  it("leaves per-member activeDays on UTC calendar days — only the headline rolls", () => {
    // Two events 3 hours apart straddling a UTC midnight: ONE rolling-24h
    // member, but still TWO distinct UTC active days for the trend.
    const now = new Date("2026-09-16T02:00:00.000Z");
    const events = [
      ev("session_start", "m-jojo", "2026-09-15T23:00:00.000Z"),
      ev("session_start", "m-jojo", "2026-09-16T01:00:00.000Z"),
    ];
    const { adoption } = summarizeDashboard(events, MEMBERS, { now });
    expect(adoption.activeLast24h).toBe(1);
    expect(adoption.byMember.find((m) => m.memberId === "m-jojo")!.activeDays).toBe(2);
  });
});

describe("summarizeDashboard — per-member participation", () => {
  it("counts each participation type per member, by display name", () => {
    const events = [
      ev("proposal_created", "m-jojo", ago(2)),
      ev("proposal_created", "m-jojo", ago(4)),
      ev("reaction_added", "m-jojo", ago(2)),
      ev("comment_added", "m-jon", ago(1)),
      ev("slot_filled", "m-jon", ago(1)),
      ev("slot_filled", "m-jon", ago(1)),
      // Not participation: usage + grocery events have their own panels.
      ev("session_start", "m-jon", ago(1)),
      ev("trip_completed", "m-jon", ago(1)),
    ];
    const { participation } = summarizeDashboard(events, MEMBERS, { now: NOW });
    // Alphabetical: "Jojo" before "Jon" (a leaderboard would put them in
    // whichever order flattered somebody — that is the point).
    expect(participation.byMember).toEqual([
      {
        memberId: "m-jojo",
        displayName: "Jojo",
        proposalsCreated: 2,
        reactionsAdded: 1,
        commentsAdded: 0,
        slotsFilled: 0,
        total: 3,
      },
      {
        memberId: "m-jon",
        displayName: "Jon",
        proposalsCreated: 0,
        reactionsAdded: 0,
        commentsAdded: 1,
        slotsFilled: 2,
        total: 3,
      },
      {
        memberId: "m-kai",
        displayName: "Kai",
        proposalsCreated: 0,
        reactionsAdded: 0,
        commentsAdded: 0,
        slotsFilled: 0,
        total: 0,
      },
    ]);
    expect(participation.total).toBe(6);
    expect(participation.hasActivity).toBe(true);
  });

  it("lists a member who has done nothing at all, with zeroes", () => {
    const { participation } = summarizeDashboard([], MEMBERS, { now: NOW });
    expect(participation.byMember.map((m) => m.displayName)).toEqual(["Jojo", "Jon", "Kai"]);
    expect(participation.byMember.every((m) => m.total === 0)).toBe(true);
    expect(participation.hasActivity).toBe(false);
  });

  it("orders members alphabetically, not by who did the most", () => {
    // Deliberately NOT a leaderboard (north star: low-key, judgment-free).
    const events = [ev("proposal_created", "m-kai", ago(1))];
    const { participation } = summarizeDashboard(events, MEMBERS, { now: NOW });
    expect(participation.byMember.map((m) => m.displayName)).toEqual(["Jojo", "Jon", "Kai"]);
  });
});

describe("summarizeDashboard — trips", () => {
  it("counts completed trips and lists built, and nothing else", () => {
    const events = [
      ev("trip_completed", "m-jon", ago(1)),
      ev("trip_completed", "m-jojo", ago(9)),
      ev("grocery_list_built", "m-jon", ago(1)),
      // "We have it" emits NO event (ADR 0012) — this stands in for the other
      // grocery traffic that must never inflate the trip count.
      ev("slot_filled", "m-jon", ago(1)),
    ];
    const { trips } = summarizeDashboard(events, MEMBERS, { now: NOW });
    expect(trips).toEqual({ completed: 2, listsBuilt: 1, hasActivity: true });
  });

  it("says so explicitly when there were no trips", () => {
    const { trips } = summarizeDashboard([ev("slot_filled", "m-jon", ago(1))], MEMBERS, {
      now: NOW,
    });
    expect(trips).toEqual({ completed: 0, listsBuilt: 0, hasActivity: false });
  });
});

describe("summarizeDashboard — an empty database", () => {
  it("renders every panel as an explicit empty state, not zeros that look broken", () => {
    const summary = summarizeDashboard([], [], { now: NOW });
    expect(summary.adoption).toEqual({
      hasActivity: false,
      byMember: [],
      activeLast24h: 0,
      activeThisWeek: 0,
      usageEvents: 0,
      unattributedUsageEvents: 0,
    });
    expect(summary.participation).toEqual({ hasActivity: false, byMember: [], total: 0 });
    expect(summary.trips).toEqual({ completed: 0, listsBuilt: 0, hasActivity: false });
  });
});

// ---------------------------------------------------------------------------
// The read half: an injected Supabase-like client, no live DB.
// ---------------------------------------------------------------------------

type QueryResult = { data: unknown; error: unknown };
type Filter = { op: string; column: string; value?: unknown };
type Recorded = { table: string; columns: string; filters: Filter[] };

function makeClient(opts: { events?: QueryResult; members?: QueryResult }) {
  const selects: Recorded[] = [];
  const empty: QueryResult = { data: [], error: null };

  const from = vi.fn((table: string) => ({
    select: (columns: string) => {
      const filters: Filter[] = [];
      const result = table === "events" ? (opts.events ?? empty) : (opts.members ?? empty);
      const builder = {
        gte(column: string, value: unknown) {
          filters.push({ op: "gte", column, value });
          return builder;
        },
        in(column: string, value: unknown) {
          filters.push({ op: "in", column, value });
          return builder;
        },
        order(column: string) {
          filters.push({ op: "order", column });
          return builder;
        },
        then<T>(resolve: (r: QueryResult) => T) {
          selects.push({ table, columns, filters });
          return Promise.resolve(result).then(resolve);
        },
      };
      return builder;
    },
  }));

  return {
    client: from as unknown as never,
    supabase: { from } as unknown as Parameters<typeof loadDashboardSummary>[0],
    selects,
  };
}

describe("loadDashboardSummary", () => {
  it("reads only the window's events, and only the types a panel renders", async () => {
    const { supabase, selects } = makeClient({});
    await loadDashboardSummary(supabase, { now: NOW });

    const events = selects.find((s) => s.table === "events")!;
    expect(events.columns).toBe("event_type, member_id, created_at");
    expect(events.filters).toEqual([
      { op: "gte", column: "created_at", value: "2026-08-16T12:00:00.000Z" },
      { op: "in", column: "event_type", value: DASHBOARD_EVENT_TYPES },
    ]);
    // `recipe_ingested` and `screen_view` have no panel, so they are not read.
    expect(DASHBOARD_EVENT_TYPES).not.toContain("recipe_ingested");
    expect(DASHBOARD_EVENT_TYPES).not.toContain("screen_view");
  });

  it("joins members for DISPLAY NAMES only — no roles, no emails, no user ids", async () => {
    const { supabase, selects } = makeClient({});
    await loadDashboardSummary(supabase, { now: NOW });
    const members = selects.find((s) => s.table === "members")!;
    expect(members.columns).toBe("id, display_name");
  });

  it("reads no table other than events and members", async () => {
    const { supabase, selects } = makeClient({});
    await loadDashboardSummary(supabase, { now: NOW });
    expect([...new Set(selects.map((s) => s.table))].sort()).toEqual(["events", "members"]);
  });

  it("maps snake_case rows into the summary", async () => {
    const { supabase } = makeClient({
      members: { data: [{ id: "m-jojo", display_name: "Jojo" }], error: null },
      events: {
        data: [
          { event_type: "proposal_created", member_id: "m-jojo", created_at: ago(1) },
          { event_type: "trip_completed", member_id: "m-jojo", created_at: ago(2) },
          { event_type: "session_start", member_id: "m-jojo", created_at: ago(2) },
        ],
        error: null,
      },
    });
    const summary = await loadDashboardSummary(supabase, { now: NOW });
    expect(summary.participation.byMember).toEqual([
      {
        memberId: "m-jojo",
        displayName: "Jojo",
        proposalsCreated: 1,
        reactionsAdded: 0,
        commentsAdded: 0,
        slotsFilled: 0,
        total: 1,
      },
    ]);
    expect(summary.trips.completed).toBe(1);
    expect(summary.adoption.byMember[0].activeDays).toBe(1);
  });

  it("degrades to an empty dashboard when a read fails, rather than throwing", async () => {
    const { supabase } = makeClient({
      events: { data: null, error: { message: "boom" } },
      members: { data: null, error: { message: "boom" } },
    });
    const summary = await loadDashboardSummary(supabase, { now: NOW });
    expect(summary.adoption.hasActivity).toBe(false);
    expect(summary.participation.byMember).toEqual([]);
    expect(summary.trips.completed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A FAILED read is not an empty one. Degrading to zeroes is right; REPORTING
// them as "nobody has opened the app in 30 days" is a lie, on the one screen
// whose whole job is to tell Jon the truth about adoption. `readFailed` is what
// lets the panels say "couldn't load" instead (security review #223, F1).
// ---------------------------------------------------------------------------

describe("loadDashboardSummary — a failed read is distinguishable from an empty one", () => {
  it("flags readFailed when the EVENTS read errors", async () => {
    const { supabase } = makeClient({
      events: { data: null, error: { message: "schema cache is stale" } },
    });
    const summary = await loadDashboardSummary(supabase, { now: NOW });
    expect(summary.readFailed).toBe(true);
    // Still degrades rather than throwing: the figures are zero...
    expect(summary.adoption.hasActivity).toBe(false);
  });

  it("flags readFailed when the MEMBERS read errors", async () => {
    const { supabase } = makeClient({
      members: { data: null, error: { message: "boom" } },
    });
    const summary = await loadDashboardSummary(supabase, { now: NOW });
    expect(summary.readFailed).toBe(true);
  });

  it("flags readFailed when an error arrives ALONGSIDE rows", async () => {
    // PostgREST can return a partial/errored body; an error is an error even if
    // `data` is not null, so we must never silently render what came back.
    const { supabase } = makeClient({
      events: {
        data: [{ event_type: "session_start", member_id: "m-jojo", created_at: ago(1) }],
        error: { message: "partial" },
      },
      members: { data: [{ id: "m-jojo", display_name: "Jojo" }], error: null },
    });
    expect((await loadDashboardSummary(supabase, { now: NOW })).readFailed).toBe(true);
  });

  it("does NOT flag readFailed for a genuinely empty events table", async () => {
    // The empty state must survive: no rows and no error is "nothing happened
    // yet", which is a true and useful thing to say.
    const { supabase } = makeClient({
      events: { data: [], error: null },
      members: { data: [{ id: "m-jojo", display_name: "Jojo" }], error: null },
    });
    const summary = await loadDashboardSummary(supabase, { now: NOW });
    expect(summary.readFailed).toBe(false);
    expect(summary.adoption.hasActivity).toBe(false);
  });

  it("does NOT flag readFailed on a successful read with activity", async () => {
    const { supabase } = makeClient({
      events: {
        data: [{ event_type: "trip_completed", member_id: "m-jojo", created_at: ago(1) }],
        error: null,
      },
      members: { data: [{ id: "m-jojo", display_name: "Jojo" }], error: null },
    });
    expect((await loadDashboardSummary(supabase, { now: NOW })).readFailed).toBe(false);
  });

  it("is false by default for the pure summarizer — only a READ can fail", () => {
    expect(summarizeDashboard([], MEMBERS, { now: NOW }).readFailed).toBe(false);
    expect(summarizeDashboard([], MEMBERS, { now: NOW, readFailed: true }).readFailed).toBe(true);
  });
});
