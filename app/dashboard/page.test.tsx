import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { summarizeDashboard, type DashboardSummary } from "@/lib/analytics/dashboard";

/**
 * The `/dashboard` owner gate (issue #17, ADR 0014 §3) — the route half of a
 * two-layer boundary.
 *
 * RLS is the boundary itself (`events_select` requires
 * `public.is_household_owner()` since 20260916120000; proven in
 * `supabase/tests/15_events_rls_test.sql`). This test covers the route's
 * BEHAVIOUR:
 *
 *   - a non-owner member gets **404, not 403** — a member who cannot have this
 *     screen should not learn that it exists;
 *   - and nothing is even read for them: `loadDashboardSummary` is never
 *     called, so a non-owner's request touches no event data at all;
 *   - the caller is resolved with `resolveCurrentMember`, which pins the
 *     members lookup to the VERIFIED `auth.getUser()` id. That is the #62
 *     lesson: `members_select` lets any member read all co-members, so an
 *     unfiltered read returns the OWNER's row — which here would hand a teen
 *     the whole dashboard.
 *
 * `resolveCurrentMember` runs for real over a fake client (that is the part
 * that must not be faked); only the aggregation read is stubbed, so "did it
 * fetch?" is observable.
 */

const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({
  notFound: () => notFound(),
  usePathname: () => "/dashboard",
}));

// The nav mounts the session_start beacon, which imports a "use server" module.
vi.mock("@/app/session-actions", () => ({
  recordSessionStartAction: async () => ({ ok: true }),
}));

const NOW = new Date("2026-09-15T12:00:00.000Z");
const SUMMARY = summarizeDashboard(
  [
    { eventType: "session_start", memberId: "m-owner", createdAt: NOW.toISOString() },
    { eventType: "proposal_created", memberId: "m-teen", createdAt: NOW.toISOString() },
    { eventType: "trip_completed", memberId: "m-owner", createdAt: NOW.toISOString() },
  ],
  [
    { id: "m-owner", displayName: "Jon" },
    { id: "m-teen", displayName: "Jojo" },
  ],
  { now: NOW },
);

const loadDashboardSummary = vi.fn<(...args: unknown[]) => Promise<DashboardSummary>>(
  async () => SUMMARY,
);
vi.mock("@/lib/analytics/dashboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics/dashboard")>()),
  loadDashboardSummary: (...args: unknown[]) => loadDashboardSummary(...args),
}));

// The RLS-scoped cookie-session client the Server Component is handed.
type Member = { user_id: string; display_name: string; role: "owner" | "member" };
const eq = vi.fn();
let client: unknown;

function signedInAs(user: { id: string } | null, members: Member[]) {
  let rows: Member[] = [];
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((col: keyof Member, val: unknown) => {
      eq(col, val);
      rows = rows.filter((r) => r[col] === val);
      return builder;
    }),
    maybeSingle: vi.fn(async () => ({ data: rows[0] ?? null })),
  };
  client = {
    auth: { getUser: async () => ({ data: { user } }) },
    from: (table: string) => {
      rows = table === "members" ? [...members] : [];
      return builder;
    },
  };
}

vi.mock("@/lib/supabase/server-component", () => ({
  createServerComponentClient: async () => client,
}));

const HOUSEHOLD: Member[] = [
  // The owner is inserted first: an unfiltered read returns THIS row (#62).
  { user_id: "owner-uid", display_name: "Jon", role: "owner" },
  { user_id: "teen-uid", display_name: "Jojo", role: "member" },
];

import DashboardPage from "./page";

beforeEach(() => {
  notFound.mockClear();
  loadDashboardSummary.mockClear();
  eq.mockClear();
});

describe("/dashboard — the owner gate", () => {
  it("renders the dashboard for the household owner", async () => {
    signedInAs({ id: "owner-uid" }, HOUSEHOLD);
    render(await DashboardPage());

    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /adoption/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /participation/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /trips/i })).toBeInTheDocument();
    expect(notFound).not.toHaveBeenCalled();
  });

  it("reads the events through the caller's own RLS-scoped session client", async () => {
    signedInAs({ id: "owner-uid" }, HOUSEHOLD);
    await DashboardPage();
    expect(loadDashboardSummary).toHaveBeenCalledTimes(1);
    expect(loadDashboardSummary.mock.calls[0][0]).toBe(client);
  });

  it("404s for a signed-in NON-owner member, and fetches no event data", async () => {
    signedInAs({ id: "teen-uid" }, HOUSEHOLD);
    await expect(DashboardPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(loadDashboardSummary).not.toHaveBeenCalled();
  });

  it("pins the owner check to the VERIFIED user id, not an arbitrary co-member", async () => {
    // Jojo is a member; an unfiltered `members` read would return Jon's OWNER
    // row and hand her the dashboard. The lookup must filter on her user_id.
    signedInAs({ id: "teen-uid" }, HOUSEHOLD);
    await expect(DashboardPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(eq).toHaveBeenCalledWith("user_id", "teen-uid");
  });

  it("404s when there is no membership row at all (fails closed)", async () => {
    signedInAs({ id: "stranger-uid" }, HOUSEHOLD);
    await expect(DashboardPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(loadDashboardSummary).not.toHaveBeenCalled();
  });

  it("404s when there is no verified session (fails closed)", async () => {
    signedInAs(null, HOUSEHOLD);
    await expect(DashboardPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(loadDashboardSummary).not.toHaveBeenCalled();
  });
});
